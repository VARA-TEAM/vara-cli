import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { ensureProviders } from '../src/config/providers.js'
import { McpClient } from '../src/mcp/client.js'
import { CONNECTORS, type Connector } from '../src/mcp/connectors.js'
import { McpHub } from '../src/mcp/hub.js'
import { accessToken, beginLogin, checkEndpoint, discover, oauthClientSecretNames, oauthLogout, oauthSecretName, oauthStatus, parsePasted } from '../src/mcp/oauth.js'
import { Manager, type ManagerDeps } from '../src/server/manage.js'
import { clearSecrets, scrubAll } from '../src/security/redact.js'
import { deleteSecret, getSecretsForScope, setSecret } from '../src/security/vault.js'

/**
 * A fake authorization server + MCP server on loopback. Nothing here touches the network beyond 127.0.0.1.
 * It checks what a real server checks: PKCE (S256), redirect_uri, client_id, resource, refresh-token rotation.
 */
interface Fake {
  server: Server
  origin: string
  mcpUrl: string
  /** Behaviours the tests flip. */
  opts: { expiresIn: number; registration: boolean; issuer: string | null; revocation: boolean; redirectIss: string | null }
  counts: { register: number; token: number; refresh: number; revoke: number; mcp: number }
  validAccess: Set<string>
  lastRegistration: Record<string, unknown> | null
  lastRevoked: string
}

const sha = (v: string): string => createHash('sha256').update(v).digest('base64url')

async function body(req: IncomingMessage): Promise<string> {
  let s = ''
  for await (const chunk of req) s += chunk
  return s
}

async function startFake(): Promise<Fake> {
  const codes = new Map<string, { challenge: string; redirect: string; client: string; resource: string }>()
  const refreshTokens = new Map<string, string>() // refresh token → client id
  const clients = new Set<string>()
  const fake = {
    opts: { expiresIn: 3600, registration: true, issuer: null, revocation: true, redirectIss: null },
    counts: { register: 0, token: 0, refresh: 0, revoke: 0, mcp: 0 },
    validAccess: new Set<string>(),
    lastRegistration: null,
    lastRevoked: '',
  } as unknown as Fake
  let n = 0
  const json = (res: ServerResponse, status: number, obj: unknown, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(obj))
  }
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', fake.origin)
    const p = u.pathname
    if (p === '/mcp' && req.method === 'POST') {
      fake.counts.mcp++
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]
      if (!bearer || !fake.validAccess.has(bearer)) {
        return json(res, 401, { error: 'unauthorized' }, { 'www-authenticate': `Bearer resource_metadata="${fake.origin}/.well-known/oauth-protected-resource"` })
      }
      const msg = JSON.parse(await body(req)) as { id?: number; method: string }
      if (msg.id === undefined) return void res.writeHead(202).end()
      if (msg.method === 'initialize') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } } })
      if (msg.method === 'tools/list') return json(res, 200, { jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'ping', description: 'ping', inputSchema: { type: 'object' } }] } })
      return json(res, 200, { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } })
    }
    if (p === '/.well-known/oauth-protected-resource' || p === '/.well-known/oauth-protected-resource/mcp') {
      return json(res, 200, { resource: fake.mcpUrl, authorization_servers: [fake.origin] })
    }
    if (p === '/.well-known/oauth-authorization-server') {
      return json(res, 200, {
        issuer: fake.opts.issuer ?? fake.origin,
        authorization_endpoint: `${fake.origin}/authorize`,
        token_endpoint: `${fake.origin}/token`,
        ...(fake.opts.registration ? { registration_endpoint: `${fake.origin}/register` } : {}),
        ...(fake.opts.revocation ? { revocation_endpoint: `${fake.origin}/revoke` } : {}),
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
      })
    }
    if (p === '/register' && req.method === 'POST') {
      fake.counts.register++
      fake.lastRegistration = JSON.parse(await body(req)) as Record<string, unknown>
      const id = `client-${++n}`
      clients.add(id)
      return json(res, 201, { client_id: id })
    }
    if (p === '/authorize') {
      const q = u.searchParams
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('state') || q.get('response_type') !== 'code') return json(res, 400, { error: 'invalid_request' })
      const code = `code-${randomBytes(6).toString('hex')}`
      codes.set(code, { challenge: q.get('code_challenge')!, redirect: q.get('redirect_uri')!, client: q.get('client_id')!, resource: q.get('resource') ?? '' })
      const back = new URL(q.get('redirect_uri')!)
      back.searchParams.set('code', code)
      back.searchParams.set('state', q.get('state')!)
      if (fake.opts.redirectIss) back.searchParams.set('iss', fake.opts.redirectIss)
      return void res.writeHead(302, { location: back.toString() }).end()
    }
    if (p === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(await body(req))
      fake.counts.token++
      const issue = (client: string): void => {
        const access = `at-${randomBytes(8).toString('hex')}`
        const refresh = `rt-${randomBytes(8).toString('hex')}`
        fake.validAccess.add(access)
        refreshTokens.set(refresh, client)
        json(res, 200, { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: fake.opts.expiresIn })
      }
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code') ?? '')
        codes.delete(f.get('code') ?? '')
        if (!c || sha(f.get('code_verifier') ?? '') !== c.challenge || f.get('redirect_uri') !== c.redirect || f.get('client_id') !== c.client || f.get('resource') !== c.resource) return json(res, 400, { error: 'invalid_grant', error_description: 'bad code or verifier' })
        return issue(c.client)
      }
      if (f.get('grant_type') === 'refresh_token') {
        fake.counts.refresh++
        const rt = f.get('refresh_token') ?? ''
        const client = refreshTokens.get(rt)
        if (!client) return json(res, 400, { error: 'invalid_grant' })
        refreshTokens.delete(rt) // rotation
        return issue(client)
      }
      return json(res, 400, { error: 'unsupported_grant_type' })
    }
    if (p === '/revoke' && req.method === 'POST') {
      fake.counts.revoke++
      fake.lastRevoked = new URLSearchParams(await body(req)).get('token') ?? ''
      return void res.writeHead(200).end()
    }
    res.writeHead(404).end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  fake.server = server
  fake.origin = `http://127.0.0.1:${port}`
  fake.mcpUrl = `${fake.origin}/mcp`
  return fake
}

/** Play the browser: follow the authorization URL, then deliver the redirect to wherever it points. */
async function approve(authUrl: string): Promise<{ location: string; status: number }> {
  const r = await fetch(authUrl, { redirect: 'manual' })
  const location = r.headers.get('location') ?? ''
  const cb = await fetch(location)
  return { location, status: cb.status }
}

let fake: Fake
beforeAll(async () => {
  fake = await startFake()
})
afterAll(async () => {
  fake.server.closeAllConnections?.()
  await new Promise((r) => fake.server.close(r))
})
beforeEach(async () => {
  fake.opts = { expiresIn: 3600, registration: true, issuer: null, revocation: true, redirectIss: null }
  fake.counts = { register: 0, token: 0, refresh: 0, revoke: 0, mcp: 0 }
  fake.validAccess.clear()
  await deleteSecret(oauthSecretName('t1'))
})

const login = (id = 't1') => beginLogin({ id, resourceUrl: fake.mcpUrl, clientName: 'VARA' })

describe('OAuth sign-in against a fake server', () => {
  it('discovers the server, registers VARA, signs in with PKCE and stores the tokens only in the vault', async () => {
    const d = await discover(fake.mcpUrl)
    expect(d.issuer).toBe(fake.origin)
    expect(d.registrationEndpoint).toBe(`${fake.origin}/register`)

    const h = await login()
    expect(h.authUrl).toContain('code_challenge_method=S256')
    expect(h.authUrl).toContain(`resource=${encodeURIComponent(fake.mcpUrl)}`)
    expect(h.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/)
    expect(fake.lastRegistration).toMatchObject({ redirect_uris: [h.redirectUri], token_endpoint_auth_method: 'none' })
    expect((await approve(h.authUrl)).status).toBe(200)
    await h.done

    const st = await oauthStatus('t1')
    expect(st).toMatchObject({ signedIn: true, canRefresh: true })
    expect(JSON.stringify(st)).not.toMatch(/at-|rt-/)
    const stored = (await getSecretsForScope('global'))[oauthSecretName('t1')]!
    expect(JSON.parse(stored).accessToken).toMatch(/^at-/)

    // The token is registered with the redactor.
    const access = (await accessToken('t1'))!
    expect(scrubAll(`Authorization: ${access}`)).not.toContain(access)
  })

  it('the MCP client uses the stored token, and signs in again by itself after a 401 (refresh + retry)', async () => {
    const h = await login()
    await approve(h.authUrl)
    await h.done
    const tokens = (force: boolean) => accessToken('t1', { force })
    const c = new McpClient('t1', { url: fake.mcpUrl, oauth: true }, {}, tokens)
    await c.connect()
    expect(c.error).toBe('')
    expect(c.tools.map((t) => t.name)).toEqual(['ping'])
    c.close()

    // The server forgets the access token (revoked / expired early): one refresh, then it works.
    fake.validAccess.clear()
    const before = fake.counts.refresh
    const c2 = new McpClient('t1', { url: fake.mcpUrl, oauth: true }, {}, tokens)
    await c2.connect()
    expect(c2.error).toBe('')
    expect(fake.counts.refresh).toBe(before + 1)
    c2.close()
  })

  it('reports "not signed in" instead of calling the server without a token', async () => {
    const c = new McpClient('nobody', { url: fake.mcpUrl, oauth: true }, {}, (force) => accessToken('nobody-' + String(force)))
    await c.connect()
    expect(c.status).toBe('error')
    expect(c.error).toMatch(/not signed in/)
  })

  it('refreshes before expiry (rotating the refresh token) and shares one refresh between concurrent callers', async () => {
    fake.opts.expiresIn = 120
    const h = await login()
    await approve(h.authUrl)
    await h.done
    const first = (await accessToken('t1'))!
    expect(fake.counts.refresh).toBe(0)
    const later = { now: () => Date.now() + 100_000 } // inside the 60 s skew window
    const [a, b, c] = await Promise.all([accessToken('t1', {}, later), accessToken('t1', {}, later), accessToken('t1', {}, later)])
    expect(fake.counts.refresh).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(a).not.toBe(first)
    expect((await accessToken('t1'))).toBe(a) // the new token was persisted
  })

  it('says to sign in again when the refresh token was revoked', async () => {
    fake.opts.expiresIn = 120
    const h = await login()
    await approve(h.authUrl)
    await h.done
    // Burn the refresh token behind VARA's back.
    await accessToken('t1', { force: true })
    const stored = JSON.parse((await getSecretsForScope('global'))[oauthSecretName('t1')]!)
    await setSecret(oauthSecretName('t1'), JSON.stringify({ ...stored, refreshToken: 'rt-dead-dead-dead' }))
    await expect(accessToken('t1', { force: true })).rejects.toThrow(/sign in again/)
  })

  it('rejects an answer with the wrong state, and still finishes with the right one', async () => {
    const h = await login()
    const cb = new URL(h.redirectUri)
    cb.searchParams.set('code', 'whatever')
    cb.searchParams.set('state', 'forged')
    expect((await fetch(cb)).status).toBe(400)
    await expect(h.submitPasted(cb.toString())).rejects.toThrow(/state/)
    expect((await approve(h.authUrl)).status).toBe(200)
    await h.done
    expect((await oauthStatus('t1')).signedIn).toBe(true)
  })

  it('accepts the pasted address when the browser is elsewhere (headless fallback), once', async () => {
    const h = await login()
    const r = await fetch(h.authUrl, { redirect: 'manual' })
    const location = r.headers.get('location')!
    await h.submitPasted(location) // the owner copies the address bar
    await h.done
    expect((await oauthStatus('t1')).signedIn).toBe(true)
    await expect(h.submitPasted(location)).rejects.toThrow(/already finished/)
  })

  it('parses what people paste', () => {
    expect(parsePasted('http://127.0.0.1:5/callback?code=a&state=b').get('code')).toBe('a')
    expect(parsePasted('?code=a&state=b').get('state')).toBe('b')
    expect(parsePasted('code=a&state=b').get('code')).toBe('a')
  })

  it('refuses an answer from a different issuer (mix-up) and an error answer', async () => {
    fake.opts.redirectIss = 'https://evil.example'
    const h = await login()
    await approve(h.authUrl).catch(() => {})
    await expect(h.done).rejects.toThrow(/refused/)
    fake.opts.redirectIss = null
    const h2 = await login()
    const cb = new URL(h2.redirectUri)
    cb.searchParams.set('error', 'access_denied')
    cb.searchParams.set('state', new URL(h2.authUrl).searchParams.get('state')!)
    await fetch(cb)
    await expect(h2.done).rejects.toThrow(/access_denied/)
    expect((await oauthStatus('t1')).signedIn).toBe(false)
  })

  it('can be cancelled, and frees the port', async () => {
    const h = await login()
    h.cancel()
    await expect(h.done).rejects.toThrow(/cancelled/)
    await expect(fetch(h.redirectUri).then((r) => r.status)).rejects.toThrow()
  })

  it('a server without dynamic registration needs the owner’s own app: the error names the vault secrets; with them it works', async () => {
    fake.opts.registration = false
    const n = oauthClientSecretNames('t1')
    await expect(login()).rejects.toThrow(new RegExp(n.id))
    expect(fake.counts.register).toBe(0)
    await setSecret(n.id, 'client-preregistered')
    try {
      const h = await login()
      expect(new URL(h.authUrl).searchParams.get('client_id')).toBe('client-preregistered')
      h.cancel()
      await h.done.catch(() => {})
    } finally {
      await deleteSecret(n.id)
    }
  })

  it('logout revokes at the service and deletes every stored token', async () => {
    const h = await login()
    await approve(h.authUrl)
    await h.done
    const rt = JSON.parse((await getSecretsForScope('global'))[oauthSecretName('t1')]!).refreshToken as string
    const out = await oauthLogout('t1')
    expect(out).toEqual({ revoked: true, was: true })
    expect(fake.lastRevoked).toBe(rt)
    expect((await oauthStatus('t1')).signedIn).toBe(false)
    expect((await getSecretsForScope('global'))[oauthSecretName('t1')]).toBeUndefined()
    expect(await oauthLogout('t1')).toEqual({ revoked: false, was: false })
  })

  it('logout still deletes the tokens when the server has no revocation endpoint', async () => {
    fake.opts.revocation = false
    const h = await login()
    await approve(h.authUrl)
    await h.done
    expect(await oauthLogout('t1')).toEqual({ revoked: false, was: true })
    expect(fake.counts.revoke).toBe(0)
  })

  it('refuses metadata whose issuer is not the server that was asked', async () => {
    fake.opts.issuer = 'https://somewhere-else.example'
    await expect(discover(fake.mcpUrl)).rejects.toThrow(/mix-up/)
  })
})

describe('OAuth address safety', () => {
  it('requires https except on loopback, and refuses private, metadata and credentialed addresses', () => {
    expect(() => checkEndpoint('https://example.com/x', 'x', false)).not.toThrow()
    expect(() => checkEndpoint('http://example.com/x', 'x', false)).toThrow(/https/)
    expect(() => checkEndpoint('https://10.1.2.3/x', 'x', false)).toThrow(/private/)
    expect(() => checkEndpoint('https://192.168.1.5/x', 'x', false)).toThrow(/private/)
    expect(() => checkEndpoint('https://169.254.169.254/latest', 'x', false)).toThrow(/private|metadata/)
    expect(() => checkEndpoint('https://metadata.google.internal/', 'x', false)).toThrow(/private|metadata/)
    expect(() => checkEndpoint('https://user:pw@example.com/', 'x', false)).toThrow(/user name/)
    expect(() => checkEndpoint('ftp://example.com/', 'x', false)).toThrow()
    // Loopback: only for a server that is itself on this machine.
    expect(() => checkEndpoint('http://127.0.0.1:9/x', 'x', true)).not.toThrow()
    expect(() => checkEndpoint('http://127.0.0.1:9/x', 'x', false)).toThrow(/loopback/)
  })

  it('a remote server cannot point the flow at an internal address or a plain-http endpoint', async () => {
    const calls: string[] = []
    const evil: typeof fetch = async (input) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('oauth-protected-resource')) return new Response(JSON.stringify({ authorization_servers: ['https://auth.example.com'] }), { status: 200 })
      if (url.includes('oauth-authorization-server')) {
        return new Response(JSON.stringify({ issuer: 'https://auth.example.com', authorization_endpoint: 'https://auth.example.com/a', token_endpoint: 'http://169.254.169.254/token' }), { status: 200 })
      }
      return new Response('', { status: 404 })
    }
    await expect(discover('https://mcp.example.com/mcp', { fetch: evil })).rejects.toThrow(/token endpoint/)
    expect(calls.some((u) => u.includes('169.254'))).toBe(false)
    await expect(discover('http://mcp.example.com/mcp', { fetch: evil })).rejects.toThrow(/https/)
    await expect(discover('https://10.0.0.5/mcp', { fetch: evil })).rejects.toThrow(/private/)
  })

  it('a redirect to an internal address is not followed', async () => {
    const evil: typeof fetch = async (input) => {
      const url = String(input)
      if (url.startsWith('https://mcp.example.com')) return new Response('', { status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } })
      throw new Error('should not be reached: ' + url)
    }
    // Every probe is refused; discovery falls back to defaults on the same origin, whose endpoints are https and fine —
    // the point is that the metadata address was never contacted (the evil fetch would have thrown).
    const d = await discover('https://mcp.example.com/mcp', { fetch: evil })
    expect(d.tokenEndpoint).toBe('https://mcp.example.com/token')
  })
})

describe('OAuth through the owner API (Manager)', () => {
  let config: VaraConfig
  let manager: Manager
  const test: Connector = {
    id: 'fake-remote',
    name: 'Fake (sign in)',
    category: 'code',
    description: 'a fake server',
    config: { url: '', oauth: true },
    secrets: [],
    oauth: { client: 'dynamic' },
    checked: 'test only',
  }
  beforeAll(() => {
    test.config = { url: fake.mcpUrl, oauth: true }
    CONNECTORS.push(test)
    config = ensureProviders({ ...DEFAULT_CONFIG })
    manager = new Manager({
      config: () => config,
      apply: async (next: VaraConfig) => {
        config = next
      },
      hub: new McpHub(),
      cwd: process.cwd(),
      secretNames: async () => [],
    } as unknown as ManagerDeps)
  })
  afterAll(async () => {
    CONNECTORS.splice(CONNECTORS.indexOf(test), 1)
    await oauthLogout('fake-remote')
    clearSecrets()
  })

  it('starts a sign-in, finishes it, adds the server, and never returns a token', async () => {
    const r = (await manager.route('POST', ['connectors', 'fake-remote', 'login'], {})) as { ok: true; value: { authUrl: string; redirectUri: string } }
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toMatch(/at-|rt-/)
    expect(((await manager.route('GET', ['connectors', 'fake-remote', 'login'], {})) as any).value.state).toBe('pending')
    await approve(r.value.authUrl)
    for (let i = 0; i < 100 && (manager.loginStatus('fake-remote') as any).value.state === 'pending'; i++) await new Promise((r) => setTimeout(r, 50))
    expect((manager.loginStatus('fake-remote') as any).value.state).toBe('done')
    expect(config.mcp.servers['fake-remote']).toMatchObject({ url: fake.mcpUrl, oauth: true })

    const rows = (await manager.connectors()) as any[]
    const row = rows.find((x) => x.id === 'fake-remote')
    expect(row.oauth).toMatchObject({ signedIn: true, canRefresh: true })
    expect(JSON.stringify(rows)).not.toMatch(/at-[0-9a-f]{16}|rt-[0-9a-f]{16}/)
  })

  it('refuses a sign-in for a connector that has none, and an unknown one', async () => {
    expect(await manager.route('POST', ['connectors', 'filesystem', 'login'], {})).toMatchObject({ ok: false, status: 400 })
    expect(await manager.route('POST', ['connectors', 'nope', 'login'], {})).toMatchObject({ ok: false, status: 404 })
    expect(await manager.route('POST', ['connectors', 'fake-remote', 'login', 'code'], { pasted: 'x' })).toMatchObject({ ok: false, status: 409 })
  })

  it('finishes from a pasted address and signs out', async () => {
    const r = (await manager.route('POST', ['connectors', 'fake-remote', 'login'], {})) as { ok: true; value: { authUrl: string } }
    const location = (await fetch(r.value.authUrl, { redirect: 'manual' })).headers.get('location')!
    const bad = await manager.route('POST', ['connectors', 'fake-remote', 'login', 'code'], { pasted: 'code=a&state=wrong' })
    expect(bad).toMatchObject({ ok: false })
    expect(await manager.route('POST', ['connectors', 'fake-remote', 'login', 'code'], { pasted: location })).toMatchObject({ ok: true })
    const out = (await manager.route('POST', ['connectors', 'fake-remote', 'logout'], {})) as any
    expect(out.ok).toBe(true)
    expect(out.value.revoked).toBe(true)
    expect((await oauthStatus('fake-remote')).signedIn).toBe(false)
  })
})
