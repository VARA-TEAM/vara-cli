import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { hostAllowed, newOwnerToken, sanitizeGrant, startServer, type RunningServer } from '../src/server/http.js'

/** Answers every request with one text reply, after an optional delay. */
class EchoProvider implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly reply = 'Hello from the host.', private readonly delayMs = 0) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })) as ProviderRequest)
    if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs))
    const turn: AssistantTurn = { content: this.reply, toolCalls: [] }
    yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

let dir: string
let work: string
let server: RunningServer
let host: VaraHost
let provider: EchoProvider
let base: string
const ownerToken = newOwnerToken()

const cfg = { ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider, model: 'owner-model' } }

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-host-'))
  work = await mkdtemp(join(tmpdir(), 'vara-work-'))
  provider = new EchoProvider()
  host = new VaraHost({ config: () => cfg, provider: () => provider, hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: work })
  // Generous limits: the whole suite shares one client address. The limiter itself is tested on its own server below.
  server = await startServer({ host, ownerToken, port: 0, limits: { failures: 10_000, joins: 10_000 }, onError: (e) => console.error('SERVER ERROR', e) })
  base = `http://127.0.0.1:${server.port}`
})

afterAll(async () => {
  await host.closeAll()
  await server.close()
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const api = async (path: string, token: string | null, init: RequestInit & { json?: unknown } = {}) => {
  const res = await fetch(base + path, {
    ...init,
    method: init.method ?? (init.json !== undefined ? 'POST' : 'GET'),
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string> | undefined) },
    ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : {}),
  })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, body }
}

const invite = async (preset: string, extra: Record<string, unknown> = {}) => {
  const r = await api('/api/admin/invites', ownerToken, { json: { preset, ...extra } })
  expect(r.status).toBe(200)
  return r.body as { token: string; link: string; id: string }
}
const joinAs = async (token: string, name = 'Sam') => {
  const r = await api('/api/join', null, { json: { invite: token, name } })
  expect(r.status).toBe(200)
  return r.body as { accessToken: string; guest: { id: string } }
}
const waitFor = async (fn: () => Promise<boolean>, ms = 20_000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 40))
  }
  throw new Error('timed out')
}

describe('server — authentication and hardening', () => {
  it('health is public; everything else needs a valid token', async () => {
    expect((await api('/api/health', null)).body).toMatchObject({ ok: true, name: 'vara' })
    expect((await api('/api/sessions', null)).status).toBe(401)
    expect((await api('/api/sessions', 'wrong-token')).status).toBe(401)
    expect((await api('/api/sessions', ownerToken)).status).toBe(200)
    expect((await api('/api/me', ownerToken)).body).toMatchObject({ role: 'owner', name: 'owner' })
  })

  it('refuses a request whose Host is not ours (DNS rebinding)', async () => {
    const { request } = await import('node:http')
    const status = await new Promise<number>((resolve) => {
      const r = request({ host: '127.0.0.1', port: server.port, path: '/api/health', headers: { host: 'evil.example.com' } }, (rs) => resolve(rs.statusCode ?? 0))
      r.end()
    })
    expect(status).toBe(421)
  })

  it('host allow-list: localhost always, private IPs only on a LAN bind, domains never', () => {
    expect(hostAllowed('localhost:7777', false, [])).toBe(true)
    expect(hostAllowed('127.0.0.1:1', false, [])).toBe(true)
    expect(hostAllowed('[::1]:80', false, [])).toBe(true)
    expect(hostAllowed('192.168.1.20:7777', false, [])).toBe(false)
    expect(hostAllowed('192.168.1.20:7777', true, [])).toBe(true)
    expect(hostAllowed('8.8.8.8', true, [])).toBe(false)
    expect(hostAllowed('attacker.com', true, [])).toBe(false)
    expect(hostAllowed('my-tunnel.example.org', true, ['my-tunnel.example.org'])).toBe(true)
    expect(hostAllowed(undefined, true, [])).toBe(false)
  })

  it('refuses a cross-site browser request (Origin mismatch) even with a valid token', async () => {
    const r = await api('/api/sessions', ownerToken, { json: { message: 'hi' }, headers: { origin: 'https://evil.example.com' } })
    expect(r.status).toBe(403)
  })

  it('rate limits invite guessing and repeated bad tokens, per address', async () => {
    const strict = await startServer({ host, ownerToken, port: 0, limits: { failures: 5, joins: 8 } })
    const url = `http://127.0.0.1:${strict.port}`
    const post = (p: string, body: unknown) => fetch(url + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.status)
    const codes: number[] = []
    for (let i = 0; i < 12; i++) codes.push(await post('/api/join', { invite: `guess-${i}`, name: 'x' }))
    expect(codes.slice(0, 8).every((c) => c === 400)).toBe(true)
    expect(codes[11]).toBe(429)
    // Bad bearer tokens lock the address out of the API (even for a valid token afterwards).
    const strict2 = await startServer({ host, ownerToken, port: 0, limits: { failures: 3, joins: 100 } })
    const get = (tok: string) => fetch(`http://127.0.0.1:${strict2.port}/api/sessions`, { headers: { authorization: `Bearer ${tok}` } }).then((r) => r.status)
    expect([await get('a'), await get('b'), await get('c')]).toEqual([401, 401, 401])
    expect(await get(ownerToken)).toBe(429)
    await strict.close()
    await strict2.close()
  })

  it('never leaks internals on bad input', async () => {
    const r = await api('/api/sessions', ownerToken, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } })
    expect(r.status).toBe(400)
    expect(JSON.stringify(r.body)).not.toMatch(/at .*\(|node_modules|\.ts:/)
    expect((await api('/api/nope', ownerToken)).status).toBe(404)
    const big = await fetch(base + '/api/sessions', { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(1_200_000) }) }).catch(() => null)
    expect(big === null || big.status === 413).toBe(true)
  })

  it('sanitises grant input to known fields and types', () => {
    expect(sanitizeGrant({ watch: true, hax: 1, mode: 'root', maxCostUsd: 'free', allowedModels: ['a', 5, 'b'] })).toEqual({ watch: true, allowedModels: ['a', 'b'] })
    expect(sanitizeGrant('nope')).toEqual({})
  })
})

describe('server — owner sessions, sharing and invites', () => {
  it('the owner runs a session; a viewer can watch only after it is shared', async () => {
    const created = await api('/api/sessions', ownerToken, { json: { message: 'hello there' } })
    expect(created.status).toBe(200)
    const id = created.body.id as string
    await waitFor(async () => (await api(`/api/sessions/${id}`, ownerToken)).body.state === 'ready')

    const inv = await invite('viewer')
    const g = await joinAs(inv.token, 'Vera')
    // Not shared yet: the guest cannot even tell it exists.
    expect((await api(`/api/sessions/${id}`, g.accessToken)).status).toBe(404)
    expect((await api('/api/sessions', g.accessToken)).body).toEqual([])

    expect((await api(`/api/sessions/${id}/share`, ownerToken, { json: { shared: true } })).status).toBe(200)
    const seen = await api(`/api/sessions/${id}`, g.accessToken)
    expect(seen.status).toBe(200)
    expect(seen.body.transcript.some((m: any) => m.content.includes('Hello from the host.'))).toBe(true)
    expect((await api('/api/sessions', g.accessToken)).body.map((s: any) => s.id)).toContain(id)

    // A viewer cannot talk, interrupt, change anything or reach admin.
    expect((await api(`/api/sessions/${id}/messages`, g.accessToken, { json: { text: 'hi' } })).status).toBe(403)
    expect((await api(`/api/sessions/${id}/pause`, g.accessToken, { json: {} })).status).toBe(403)
    expect((await api('/api/sessions', g.accessToken, { json: { message: 'my own' } })).status).toBe(403)
    expect((await api('/api/admin/overview', g.accessToken)).status).toBe(403)
    expect((await api('/api/admin/invites', g.accessToken, { json: { preset: 'viewer' } })).status).toBe(403)
    expect((await api(`/api/sessions/${id}/share`, g.accessToken, { json: { shared: false } })).status).toBe(403)
  })

  it('a participant talks in the shared session with attribution; the model sees who said it', async () => {
    const created = await api('/api/sessions', ownerToken, { json: { message: 'hello there' } })
    const id = created.body.id as string
    await waitFor(async () => (await api(`/api/sessions/${id}`, ownerToken)).body.state === 'ready')
    await api(`/api/sessions/${id}/share`, ownerToken, { json: { shared: true } })

    const g = await joinAs((await invite('participant')).token, 'Noor')
    provider.requests.length = 0
    const sent = await api(`/api/sessions/${id}/messages`, g.accessToken, { json: { text: 'what about tests?' } })
    expect(sent.status).toBe(200)
    await waitFor(async () => provider.requests.length > 0)
    const last = provider.requests[0]!.messages.filter((m) => !m.content.startsWith('[STATE]')).at(-1)!
    expect(last.content).toBe('[from Noor] what about tests?')
    // No session of their own, though.
    expect((await api('/api/sessions', g.accessToken, { json: { message: 'mine' } })).status).toBe(403)
  })

  it('a collaborator gets an independent session in the same folder; model locked, read-only agent, invisible to other guests', async () => {
    const g1 = await joinAs((await invite('collaborator')).token, 'Ali')
    const g2 = await joinAs((await invite('collaborator')).token, 'Bea')
    const mine = await api('/api/sessions', g1.accessToken, { json: { message: 'explain the project please' } })
    expect(mine.status).toBe(200)
    expect(mine.body.mode).toBe('plan')
    expect(mine.body.participant.id).toBe(g1.guest.id)
    expect(mine.body.model).toBe('owner-model')
    const id = mine.body.id as string
    await waitFor(async () => (await api(`/api/sessions/${id}`, g1.accessToken)).body.state === 'ready')

    // Bea cannot see, read, message or pause Ali's session — it does not even "exist" for her.
    expect((await api(`/api/sessions/${id}`, g2.accessToken)).status).toBe(404)
    expect((await api(`/api/sessions/${id}/messages`, g2.accessToken, { json: { text: 'hey' } })).status).toBe(404)
    expect((await api('/api/sessions', g2.accessToken)).body.find((s: any) => s.id === id)).toBeUndefined()
    // The owner sees everything.
    expect((await api('/api/sessions', ownerToken)).body.map((s: any) => s.id)).toContain(id)
    expect((await api(`/api/sessions/${id}`, ownerToken)).status).toBe(200)

    // Locked: cannot switch model or raise power.
    expect((await api(`/api/sessions/${id}/model`, g1.accessToken, { json: { model: 'expensive-model' } })).status).toBe(403)
    expect((await api(`/api/sessions/${id}/mode`, g1.accessToken, { json: { mode: 'build' } })).status).toBe(403)
    expect((await api('/api/sessions', g1.accessToken, { json: { message: 'build me a thing', mode: 'build' } })).status).toBe(403)
    expect((await api('/api/sessions', g1.accessToken, { json: { message: 'other model please', model: 'expensive-model' } })).status).toBe(403)
    // …but their own session is theirs to use.
    expect((await api(`/api/sessions/${id}/messages`, g1.accessToken, { json: { text: 'and the tests?' } })).status).toBe(200)
  })

  it('a granted guest can build and switch among the allowed models only', async () => {
    const inv = await invite('collaborator', { grant: { mode: 'build', canChangeMode: true, modelPolicy: 'list', allowedModels: ['cheap-a', 'cheap-b'] } })
    const g = await joinAs(inv.token, 'Dev')
    const s = await api('/api/sessions', g.accessToken, { json: { message: 'create a file named x.txt', mode: 'build' } })
    expect(s.status).toBe(200)
    expect(s.body.mode).toBe('build')
    expect(s.body.model).toBe('cheap-a') // first allowed, not the owner's model
    const id = s.body.id as string
    await waitFor(async () => ['ready', 'completed', 'waiting_user', 'paused'].includes((await api(`/api/sessions/${id}`, g.accessToken)).body.state))
    expect((await api(`/api/sessions/${id}/model`, g.accessToken, { json: { model: 'cheap-b' } })).status).toBe(200)
    expect((await api(`/api/sessions/${id}/model`, g.accessToken, { json: { model: 'owner-model' } })).status).toBe(403)
    expect((await api(`/api/sessions/${id}/mode`, g.accessToken, { json: { mode: 'plan' } })).status).toBe(200)
  })

  it('the owner tightens a grant live: it applies on the guest’s very next request', async () => {
    const inv = await invite('collaborator', { grant: { mode: 'build', canChangeMode: true } })
    const g = await joinAs(inv.token, 'Tara')
    const s = await api('/api/sessions', g.accessToken, { json: { message: 'create a file named y.txt', mode: 'build' } })
    expect(s.body.mode).toBe('build')
    const id = s.body.id as string
    await waitFor(async () => ['ready', 'completed', 'waiting_user', 'paused'].includes((await api(`/api/sessions/${id}`, g.accessToken)).body.state))

    await api(`/api/admin/guests/${g.guest.id}`, ownerToken, { method: 'PATCH', json: { grant: { mode: 'plan' } } })
    expect((await api('/api/me', g.accessToken)).body.grant.mode).toBe('plan')
    expect((await api(`/api/sessions/${id}/mode`, g.accessToken, { json: { mode: 'build' } })).status).toBe(403)
    // The existing session is pulled down to read-only before the next turn.
    await api(`/api/sessions/${id}/messages`, g.accessToken, { json: { text: 'continue please' } })
    expect((await api(`/api/sessions/${id}`, ownerToken)).body.mode).toBe('plan')
  })

  it('usage caps stop a guest and the owner sees consumption per guest', async () => {
    const inv = await invite('collaborator', { grant: { maxModelCalls: 1 } })
    const g = await joinAs(inv.token, 'Cap')
    const s = await api('/api/sessions', g.accessToken, { json: { message: 'hello' } })
    expect(s.status).toBe(200)
    const id = s.body.id as string
    await waitFor(async () => (await api(`/api/sessions/${id}`, g.accessToken)).body.state === 'ready')
    const again = await api(`/api/sessions/${id}/messages`, g.accessToken, { json: { text: 'one more' } })
    expect(again.status).toBe(403)
    expect(again.body.error).toMatch(/limit of 1 model calls/)
    expect((await api('/api/sessions', g.accessToken, { json: { message: 'new one' } })).status).toBe(403)

    const overview = await api('/api/admin/overview', ownerToken)
    const row = overview.body.guests.find((x: any) => x.id === g.guest.id)
    expect(row).toMatchObject({ name: 'Cap', sessions: 1, modelCalls: 1 })
  })

  it('revoking a guest cuts them off at once, stops their agents and closes their live stream', async () => {
    const g = await joinAs((await invite('collaborator')).token, 'Gone')
    const s = await api('/api/sessions', g.accessToken, { json: { message: 'hello' } })
    const id = s.body.id as string
    await waitFor(async () => (await api(`/api/sessions/${id}`, g.accessToken)).body.state === 'ready')

    const events: string[] = []
    const ctl = new AbortController()
    const stream = await fetch(`${base}/api/sessions/${id}/events?access_token=${g.accessToken}`, { signal: ctl.signal })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    const done = (async () => {
      const dec = new TextDecoder()
      try {
        for (;;) {
          const { value, done: d } = await reader.read()
          if (d) return
          events.push(dec.decode(value))
        }
      } catch {
        /* aborted */
      }
    })()
    await waitFor(async () => events.join('').includes(': connected'))
    expect((await api(`/api/admin/guests/${g.guest.id}`, ownerToken, { method: 'DELETE' })).status).toBe(200)
    await waitFor(async () => events.join('').includes('"type":"revoked"'))
    await done
    expect((await api('/api/me', g.accessToken)).status).toBe(401)
    expect((await api(`/api/sessions/${id}`, g.accessToken)).status).toBe(401)
    ctl.abort()
  })

  it('streams live events with replay, hides the model’s private reasoning from guests', async () => {
    const created = await api('/api/sessions', ownerToken, { json: { message: 'hello again' } })
    const id = created.body.id as string
    await waitFor(async () => (await api(`/api/sessions/${id}`, ownerToken)).body.state === 'ready')
    await api(`/api/sessions/${id}/share`, ownerToken, { json: { shared: true } })
    const g = await joinAs((await invite('viewer')).token, 'Eve')

    const read = async (token: string, after = 0) => {
      const ctl = new AbortController()
      const res = await fetch(`${base}/api/sessions/${id}/events?after=${after}&access_token=${token}`, { signal: ctl.signal })
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let text = ''
      const end = Date.now() + 600
      while (Date.now() < end) {
        const { value } = await Promise.race([reader.read(), new Promise<{ value: undefined }>((r) => setTimeout(() => r({ value: undefined }), 150))])
        if (value) text += dec.decode(value)
      }
      ctl.abort()
      return text
    }
    const full = await read(g.accessToken)
    expect(full).toContain('"type":"message"')
    expect(full).toContain('"type":"state"')
    const ids = [...full.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]))
    expect(ids.length).toBeGreaterThan(2)
    // Resuming after the last id replays nothing old.
    const resumed = await read(g.accessToken, Math.max(...ids))
    expect(resumed).not.toContain('"type":"message"')
  })
})

describe('server — invite links carry the address guests can reach', () => {
  it('uses publicUrl when set, otherwise the address the owner used', async () => {
    const withPublic = await startServer({ host, ownerToken, port: 0, publicUrl: () => 'http://192.168.1.50:7777', limits: { failures: 10_000, joins: 10_000 } })
    const r = await fetch(`http://127.0.0.1:${withPublic.port}/api/admin/invites`, { method: 'POST', headers: { authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json' }, body: JSON.stringify({ preset: 'viewer' }) })
    expect(((await r.json()) as { link: string }).link).toMatch(/^http:\/\/192\.168\.1\.50:7777\/join\//)
    await withPublic.close()
    const plain = (await invite('viewer')).link
    expect(plain).toContain(`http://127.0.0.1:${server.port}/join/`)
  })

  it('serves the embedded web interface with a strict content policy', async () => {
    const page = await fetch(base + '/')
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).toContain('<div id="root">')
    expect(page.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    const js = await fetch(base + '/assets/app.js')
    expect(js.status).toBe(200)
    expect(js.headers.get('content-type')).toContain('javascript')
    expect((await fetch(base + '/assets/nope.js')).status).toBe(404)
    // the join page is the same app
    expect((await fetch(base + '/join/anything')).status).toBe(200)
  })

  it('reports host info and per-session capabilities', async () => {
    const me = await api('/api/me', ownerToken)
    expect(me.body.host).toMatchObject({ provider: 'openai', model: 'owner-model' })
    const g = await joinAs((await invite('viewer')).token, 'Cap')
    const created = await api('/api/sessions', ownerToken, { json: { message: 'hello caps' } })
    await api(`/api/sessions/${created.body.id}/share`, ownerToken, { json: { shared: true } })
    const seen = await api(`/api/sessions/${created.body.id}`, g.accessToken)
    expect(seen.body.can).toEqual({ send: false, pause: false, setMode: false, setModel: false, manage: false })
    expect((await api(`/api/sessions/${created.body.id}`, ownerToken)).body.can.send).toBe(true)
  })
})
