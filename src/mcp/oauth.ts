import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { hostOf, isLoopback, isPrivateHost } from '../browser/policy.js'
import { deleteSecret, getSecretsForScope, setSecret } from '../security/vault.js'
import { registerSecret, scrubAll } from '../security/redact.js'

/**
 * OAuth sign-in for remote MCP servers (the MCP authorization flow: OAuth 2.1 + PKCE, protected-resource and
 * authorization-server metadata discovery, dynamic client registration when the server offers it).
 *
 * Rules this file keeps:
 *  - Tokens (access, refresh, client secret) live ONLY in the encrypted vault, as one JSON secret per connector,
 *    and are registered with the redactor. Nothing here returns a token to a caller other than the MCP transport
 *    (`accessToken`) — status and login results carry no secret.
 *  - Every URL we fetch (the server, the metadata, the endpoints it names, every redirect) must be https, or http on
 *    a loopback address when the MCP server itself is on loopback (a local test server). Private-network and
 *    cloud-metadata addresses are refused, with the same rules as the browser tool's OriginPolicy.
 *  - The authorization response is accepted only with the `state` we generated (and the `iss` it was issued by, when
 *    the server sends one); a code is exchanged once.
 */

export interface OAuthRecord {
  v: 1
  resource: string
  issuer: string
  tokenEndpoint: string
  revocationEndpoint?: string
  clientId: string
  clientSecret?: string
  authMethod: 'none' | 'client_secret_post' | 'client_secret_basic'
  scope?: string
  accessToken: string
  refreshToken?: string
  /** Epoch ms; absent when the server did not say. */
  expiresAt?: number
}

export interface OAuthStatus {
  signedIn: boolean
  /** Epoch ms of the access token's expiry, when known. */
  expiresAt?: number
  canRefresh: boolean
  /** Host of the authorization server — never a token. */
  issuerHost?: string
}

export interface OAuthEnv {
  fetch?: typeof fetch
  now?: () => number
}

const SECRET_PREFIX = 'OAUTH_TOKENS_'
const REFRESH_SKEW_MS = 60_000
const LOGIN_TIMEOUT_MS = 5 * 60_000
const MAX_BODY = 512 * 1024
const MAX_REDIRECTS = 3

const idKey = (id: string): string => id.toUpperCase().replace(/[^A-Z0-9]/g, '_')
/** Vault name of a connector's token record. */
export const oauthSecretName = (id: string): string => `${SECRET_PREFIX}${idKey(id)}`
/** Vault names the owner may fill for a service that does not support dynamic registration. */
export const oauthClientSecretNames = (id: string): { id: string; secret: string } => ({ id: `OAUTH_CLIENT_ID_${idKey(id)}`, secret: `OAUTH_CLIENT_SECRET_${idKey(id)}` })

const b64url = (b: Buffer): string => b.toString('base64url')

/* ------------------------------ URL safety ------------------------------ */

/** Throws unless `url` may be contacted. `allowLoopback` only when the MCP server itself is on loopback. */
export function checkEndpoint(url: string, what: string, allowLoopback: boolean): URL {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    throw new Error(`${what}: not a valid address`)
  }
  const host = hostOf(url)
  if (!host) throw new Error(`${what}: only https addresses are allowed`)
  if (u.username || u.password) throw new Error(`${what}: an address with a user name or password is refused`)
  const loop = isLoopback(host)
  if (loop && !allowLoopback) throw new Error(`${what}: a loopback address is refused for a server that is not on this machine`)
  if (!loop && u.protocol !== 'https:') throw new Error(`${what}: https is required (${host})`)
  if (!loop && isPrivateHost(host)) throw new Error(`${what}: ${host} is on a private network or is a metadata address; refused`)
  return u
}

interface Guard {
  fetch: typeof fetch
  allowLoopback: boolean
}

async function readCapped(res: Response): Promise<string> {
  const text = await res.text()
  return text.length > MAX_BODY ? text.slice(0, MAX_BODY) : text
}

/** fetch with a timeout, no automatic redirects (each hop is checked) and a capped body. */
async function guarded(g: Guard, url: string, init: RequestInit, what: string): Promise<{ res: Response; text: string }> {
  let target = url
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkEndpoint(target, what, g.allowLoopback)
    const res = await g.fetch(target, { ...init, redirect: 'manual', signal: AbortSignal.timeout(20_000) })
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      target = new URL(res.headers.get('location')!, target).toString()
      continue
    }
    return { res, text: await readCapped(res) }
  }
  throw new Error(`${what}: too many redirects`)
}

function parseJson(text: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(text) as unknown
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

/* ------------------------------ discovery ------------------------------ */

export interface Discovery {
  resource: string
  issuer: string
  authorizationEndpoint: string
  tokenEndpoint: string
  registrationEndpoint?: string
  revocationEndpoint?: string
  authMethods: string[]
  scopes?: string[]
}

function wellKnown(base: URL, suffix: string): string {
  const path = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '')
  return `${base.origin}/.well-known/${suffix}${path}`
}

/** `WWW-Authenticate: Bearer resource_metadata="https://…"` → the URL. */
export function resourceMetadataFrom(header: string | null): string | undefined {
  const m = header?.match(/resource_metadata="([^"]+)"/i)
  return m?.[1]
}

export async function discover(resourceUrl: string, env: OAuthEnv = {}): Promise<Discovery> {
  const base = checkEndpoint(resourceUrl, 'the MCP server address', true)
  const allowLoopback = isLoopback(hostOf(resourceUrl) ?? '')
  const g: Guard = { fetch: env.fetch ?? fetch, allowLoopback }

  // 1. Protected-resource metadata: from the 401 challenge, else the well-known locations.
  let prm: Record<string, unknown> | null = null
  const candidates: string[] = []
  try {
    const probe = await guarded(
      g,
      resourceUrl,
      { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'vara', version: '0' } } }) },
      'the MCP server',
    )
    const hinted = resourceMetadataFrom(probe.res.headers.get('www-authenticate'))
    if (hinted) candidates.push(new URL(hinted, base).toString())
  } catch {
    /* an unreachable probe falls through to the well-known locations */
  }
  candidates.push(wellKnown(base, 'oauth-protected-resource'), `${base.origin}/.well-known/oauth-protected-resource`)
  for (const c of candidates) {
    try {
      const r = await guarded(g, c, { headers: { accept: 'application/json' } }, 'the resource metadata')
      const j = r.res.ok ? parseJson(r.text) : null
      if (j) {
        prm = j
        break
      }
    } catch {
      /* try the next one */
    }
  }
  const servers = Array.isArray(prm?.['authorization_servers']) ? (prm!['authorization_servers'] as unknown[]).filter((s): s is string => typeof s === 'string') : []
  const issuerUrl = servers[0] ?? base.origin
  const issuer = checkEndpoint(issuerUrl, 'the authorization server', allowLoopback)

  // 2. Authorization-server metadata.
  const ip = issuer.pathname === '/' ? '' : issuer.pathname.replace(/\/$/, '')
  const asCandidates = ip
    ? [`${issuer.origin}/.well-known/oauth-authorization-server${ip}`, `${issuer.origin}/.well-known/openid-configuration${ip}`, `${issuer.origin}${ip}/.well-known/openid-configuration`]
    : [`${issuer.origin}/.well-known/oauth-authorization-server`, `${issuer.origin}/.well-known/openid-configuration`]
  let meta: Record<string, unknown> | null = null
  for (const c of asCandidates) {
    try {
      const r = await guarded(g, c, { headers: { accept: 'application/json' } }, 'the authorization-server metadata')
      const j = r.res.ok ? parseJson(r.text) : null
      if (j) {
        meta = j
        break
      }
    } catch {
      /* next */
    }
  }
  const norm = (s: string): string => s.replace(/\/+$/, '')
  if (meta) {
    const claimed = str(meta['issuer'])
    if (claimed && norm(claimed) !== norm(issuer.toString())) throw new Error(`the authorization server named itself "${claimed}", not "${norm(issuer.toString())}" — refusing (possible mix-up)`)
    const methods = meta['code_challenge_methods_supported']
    if (Array.isArray(methods) && !methods.includes('S256')) throw new Error('the authorization server does not support PKCE S256')
  }
  // The MCP spec's fallback when a server publishes no metadata at all.
  const pick = (key: string, fallback?: string): string | undefined => str(meta?.[key]) ?? (fallback ? `${issuer.origin}${fallback}` : undefined)
  const authorizationEndpoint = pick('authorization_endpoint', '/authorize')!
  const tokenEndpoint = pick('token_endpoint', '/token')!
  const registrationEndpoint = pick('registration_endpoint', meta ? undefined : '/register')
  const revocationEndpoint = pick('revocation_endpoint')
  for (const [what, u] of [['authorization endpoint', authorizationEndpoint], ['token endpoint', tokenEndpoint], ['registration endpoint', registrationEndpoint], ['revocation endpoint', revocationEndpoint]] as const) {
    if (u) checkEndpoint(u, `the ${what}`, allowLoopback)
  }
  const scopes = Array.isArray(prm?.['scopes_supported']) ? (prm!['scopes_supported'] as unknown[]).filter((s): s is string => typeof s === 'string') : undefined
  return {
    resource: str(prm?.['resource']) ?? resourceUrl,
    issuer: norm(issuer.toString()),
    authorizationEndpoint,
    tokenEndpoint,
    ...(registrationEndpoint ? { registrationEndpoint } : {}),
    ...(revocationEndpoint ? { revocationEndpoint } : {}),
    authMethods: Array.isArray(meta?.['token_endpoint_auth_methods_supported']) ? (meta!['token_endpoint_auth_methods_supported'] as unknown[]).filter((s): s is string => typeof s === 'string') : ['client_secret_basic'],
    ...(scopes?.length ? { scopes } : {}),
  }
}

/* ------------------------------ token endpoint ------------------------------ */

interface TokenResponse {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  scope?: string
}

function authFor(rec: Pick<OAuthRecord, 'clientId' | 'clientSecret' | 'authMethod'>, params: URLSearchParams, headers: Record<string, string>): void {
  if (rec.authMethod === 'client_secret_basic' && rec.clientSecret) {
    headers['authorization'] = `Basic ${Buffer.from(`${encodeURIComponent(rec.clientId)}:${encodeURIComponent(rec.clientSecret)}`).toString('base64')}`
  } else {
    params.set('client_id', rec.clientId)
    if (rec.authMethod === 'client_secret_post' && rec.clientSecret) params.set('client_secret', rec.clientSecret)
  }
}

async function tokenRequest(g: Guard, endpoint: string, rec: Pick<OAuthRecord, 'clientId' | 'clientSecret' | 'authMethod'>, params: URLSearchParams, now: number): Promise<TokenResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  authFor(rec, params, headers)
  const { res, text } = await guarded(g, endpoint, { method: 'POST', headers, body: params.toString() }, 'the token endpoint')
  const j = parseJson(text)
  if (!res.ok || !j || j['error'] || !str(j['access_token'])) {
    const code = str(j?.['error']) ?? `HTTP ${res.status}`
    const desc = str(j?.['error_description'])
    const err = new Error(scrubAll(`the token endpoint refused the request: ${code}${desc ? ` — ${desc.slice(0, 200)}` : ''}`))
    ;(err as Error & { code?: string }).code = code
    throw err
  }
  const expires = typeof j['expires_in'] === 'number' ? j['expires_in'] : Number(j['expires_in'])
  const out: TokenResponse = { accessToken: str(j['access_token'])! }
  const refresh = str(j['refresh_token'])
  if (refresh) out.refreshToken = refresh
  if (Number.isFinite(expires) && expires > 0) out.expiresAt = now + expires * 1000
  const scope = str(j['scope'])
  if (scope) out.scope = scope
  return out
}

/* ------------------------------ storage ------------------------------ */

function register(rec: OAuthRecord): void {
  registerSecret(rec.accessToken, 'oauth-access-token')
  if (rec.refreshToken) registerSecret(rec.refreshToken, 'oauth-refresh-token')
  if (rec.clientSecret) registerSecret(rec.clientSecret, 'oauth-client-secret')
}

async function save(id: string, rec: OAuthRecord): Promise<void> {
  register(rec)
  await setSecret(oauthSecretName(id), JSON.stringify(rec))
}

async function load(id: string): Promise<OAuthRecord | null> {
  const all = await getSecretsForScope('global')
  const raw = all[oauthSecretName(id)]
  if (!raw) return null
  const rec = parseJson(raw) as unknown as OAuthRecord | null
  if (!rec || rec.v !== 1 || typeof rec.accessToken !== 'string') return null
  register(rec)
  return rec
}

export async function oauthStatus(id: string): Promise<OAuthStatus> {
  const rec = await load(id).catch(() => null)
  if (!rec) return { signedIn: false, canRefresh: false }
  return { signedIn: true, canRefresh: !!rec.refreshToken, ...(rec.expiresAt ? { expiresAt: rec.expiresAt } : {}), ...(hostOf(rec.issuer) ? { issuerHost: hostOf(rec.issuer)! } : {}) }
}

/** Client id / secret the owner stored by hand (`vara secret set OAUTH_CLIENT_ID_<ID>`), for services without dynamic registration. */
async function preregistered(id: string): Promise<{ clientId: string; clientSecret?: string } | null> {
  const names = oauthClientSecretNames(id)
  const all = await getSecretsForScope('global').catch(() => ({}) as Record<string, string>)
  const clientId = all[names.id]
  if (!clientId) return null
  const clientSecret = all[names.secret]
  if (clientSecret) registerSecret(clientSecret, names.secret)
  return { clientId, ...(clientSecret ? { clientSecret } : {}) }
}

/* ------------------------------ access token (used by the MCP client) ------------------------------ */

const refreshing = new Map<string, Promise<string | undefined>>()

/**
 * The bearer token for a connector, refreshed first when it is about to expire (or when `force` — after a 401).
 * Returns undefined when not signed in. Concurrent callers share one refresh.
 */
export function accessToken(id: string, opts: { force?: boolean } = {}, env: OAuthEnv = {}): Promise<string | undefined> {
  const running = refreshing.get(id)
  if (running) return running
  const p = (async () => {
    const now = (env.now ?? Date.now)()
    const rec = await load(id)
    if (!rec) return undefined
    const stale = rec.expiresAt !== undefined && rec.expiresAt - now < REFRESH_SKEW_MS
    if (!stale && !opts.force) return rec.accessToken
    if (!rec.refreshToken) {
      if (stale) throw new Error(`the sign-in expired and has no refresh token — sign in again: vara connectors login ${id}`)
      return rec.accessToken
    }
    const g: Guard = { fetch: env.fetch ?? fetch, allowLoopback: isLoopback(hostOf(rec.resource) ?? '') }
    try {
      const t = await tokenRequest(g, rec.tokenEndpoint, rec, new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rec.refreshToken, resource: rec.resource }), now)
      const next: OAuthRecord = { ...rec, accessToken: t.accessToken, refreshToken: t.refreshToken ?? rec.refreshToken, ...(t.scope ? { scope: t.scope } : {}) }
      if (t.expiresAt) next.expiresAt = t.expiresAt
      else delete next.expiresAt
      await save(id, next)
      return next.accessToken
    } catch (err) {
      if ((err as { code?: string }).code === 'invalid_grant') throw new Error(`the sign-in was revoked or expired — sign in again: vara connectors login ${id}`)
      throw err
    }
  })().finally(() => refreshing.delete(id))
  refreshing.set(id, p)
  return p
}

/** Sign out: ask the server to revoke the token when it offers that, then delete everything we stored. */
export async function oauthLogout(id: string, env: OAuthEnv = {}): Promise<{ revoked: boolean; was: boolean }> {
  const rec = await load(id).catch(() => null)
  let revoked = false
  if (rec?.revocationEndpoint) {
    try {
      const g: Guard = { fetch: env.fetch ?? fetch, allowLoopback: isLoopback(hostOf(rec.resource) ?? '') }
      const token = rec.refreshToken ?? rec.accessToken
      const params = new URLSearchParams({ token, token_type_hint: rec.refreshToken ? 'refresh_token' : 'access_token' })
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' }
      authFor(rec, params, headers)
      const { res } = await guarded(g, rec.revocationEndpoint, { method: 'POST', headers, body: params.toString() }, 'the revocation endpoint')
      revoked = res.ok
    } catch {
      /* the local copy is deleted regardless */
    }
  }
  const was = await deleteSecret(oauthSecretName(id))
  return { revoked, was }
}

/* ------------------------------ login ------------------------------ */

export interface LoginOptions {
  /** Connector id (the vault record is named after it). */
  id: string
  /** The MCP server's URL. */
  resourceUrl: string
  scope?: string
  /** A fixed local port (for services that need an exact callback URL); default: a random one. */
  port?: number
  clientName?: string
}

export interface LoginHandle {
  /** Open this in a browser. It carries no token; it is single-use and expires with the login (5 minutes). */
  authUrl: string
  redirectUri: string
  /** Resolves when the tokens are stored; rejects with a readable reason. */
  done: Promise<void>
  /** Headless fallback: the address the browser ended up on (or just its query string) after approving. */
  submitPasted(pasted: string): Promise<void>
  cancel(): void
}

const PAGE = (title: string, body: string): string => `<!doctype html><meta charset="utf-8"><title>VARA</title><body style="font:16px system-ui;max-width:32rem;margin:4rem auto;padding:0 1rem"><h1>${title}</h1><p>${body}</p></body>`

function listen(port: number): Promise<{ server: Server; port: number }> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, port: (server.address() as { port: number }).port }))
  })
}

async function register_(g: Guard, d: Discovery, redirectUri: string, name: string): Promise<{ clientId: string; clientSecret?: string; authMethod: OAuthRecord['authMethod'] }> {
  const body = { client_name: name, redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }
  const { res, text } = await guarded(g, d.registrationEndpoint!, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body) }, 'the registration endpoint')
  const j = parseJson(text)
  const clientId = str(j?.['client_id'])
  if (!res.ok || !clientId) throw new Error(scrubAll(`the server refused to register VARA as an app (HTTP ${res.status}${str(j?.['error_description']) ? `: ${str(j?.['error_description'])!.slice(0, 200)}` : ''})`))
  const clientSecret = str(j?.['client_secret'])
  const m = str(j?.['token_endpoint_auth_method'])
  return { clientId, ...(clientSecret ? { clientSecret } : {}), authMethod: clientSecret ? (m === 'client_secret_basic' ? 'client_secret_basic' : 'client_secret_post') : 'none' }
}

/** Parse what the owner pasted: a full redirect address, `?code=…&state=…`, or `code=…&state=…`. */
export function parsePasted(pasted: string): URLSearchParams {
  const t = pasted.trim()
  try {
    return new URL(t).searchParams
  } catch {
    return new URLSearchParams(t.replace(/^[^?]*\?/, ''))
  }
}

export async function beginLogin(opts: LoginOptions, env: OAuthEnv = {}): Promise<LoginHandle> {
  const fetchFn = env.fetch ?? fetch
  const now = env.now ?? Date.now
  const d = await discover(opts.resourceUrl, env)
  const g: Guard = { fetch: fetchFn, allowLoopback: isLoopback(hostOf(opts.resourceUrl) ?? '') }
  const { server, port } = await listen(opts.port ?? 0)
  const redirectUri = `http://127.0.0.1:${port}/callback`
  let timer: ReturnType<typeof setTimeout> | undefined
  const closeAll = (): void => {
    if (timer) clearTimeout(timer)
    // Stop listening now, but let the answer to the browser that is mid-request go out before the sockets are cut.
    server.close()
    setTimeout(() => server.closeAllConnections?.(), 2_000).unref()
  }
  let settled = false
  let inflight = 0
  /** Close once the attempt is over AND no browser is still waiting for its answer. */
  const maybeClose = (): void => {
    if (settled && inflight === 0) closeAll()
  }
  try {
    const pre = await preregistered(opts.id)
    let client: { clientId: string; clientSecret?: string; authMethod: OAuthRecord['authMethod'] }
    if (pre) {
      const wantsBasic = !d.authMethods.includes('client_secret_post') && d.authMethods.includes('client_secret_basic')
      client = { clientId: pre.clientId, ...(pre.clientSecret ? { clientSecret: pre.clientSecret } : {}), authMethod: pre.clientSecret ? (wantsBasic ? 'client_secret_basic' : 'client_secret_post') : 'none' }
    } else if (d.registrationEndpoint) {
      client = await register_(g, d, redirectUri, opts.clientName ?? 'VARA')
    } else {
      const n = oauthClientSecretNames(opts.id)
      throw new Error(`this server does not offer automatic app registration. Create an OAuth app with the service, then store its credentials: vara secret set ${n.id}  (and ${n.secret} if it has a secret). Steps: docs/OAUTH.md`)
    }
    const verifier = b64url(randomBytes(48))
    const challenge = b64url(createHash('sha256').update(verifier).digest())
    const state = b64url(randomBytes(32))
    const scope = opts.scope ?? d.scopes?.join(' ')
    const url = new URL(d.authorizationEndpoint)
    for (const [k, v] of Object.entries({ response_type: 'code', client_id: client.clientId, redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256', state, resource: d.resource })) url.searchParams.set(k, v)
    if (scope) url.searchParams.set('scope', scope)

    let resolveDone!: () => void
    let rejectDone!: (e: Error) => void
    const done = new Promise<void>((res, rej) => {
      resolveDone = res
      rejectDone = rej
    })
    done.catch(() => {})
    const fail = (e: Error): void => {
      if (settled) return
      settled = true
      maybeClose()
      rejectDone(e)
    }
    const finish = async (params: URLSearchParams): Promise<void> => {
      if (settled) throw new Error('this sign-in is already finished — start it again')
      const got = params.get('state') ?? ''
      const a = Buffer.from(got)
      const b = Buffer.from(state)
      if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error('the sign-in answer did not carry the expected state — ignored (paste the whole address from your browser)')
      const iss = params.get('iss')
      if (iss && iss.replace(/\/+$/, '') !== d.issuer) {
        fail(new Error(`the answer came from "${iss}", not from ${d.issuer} — refused`))
        throw new Error('wrong issuer')
      }
      const err = params.get('error')
      if (err) {
        const e = new Error(scrubAll(`the service said no: ${err}${params.get('error_description') ? ` — ${params.get('error_description')!.slice(0, 200)}` : ''}`))
        fail(e)
        throw e
      }
      const code = params.get('code')
      if (!code) throw new Error('the sign-in answer had no code')
      settled = true // a code is exchanged once
      maybeClose()
      try {
        const t = await tokenRequest(g, d.tokenEndpoint, client, new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, resource: d.resource }), now())
        const rec: OAuthRecord = {
          v: 1,
          resource: d.resource === opts.resourceUrl ? d.resource : opts.resourceUrl,
          issuer: d.issuer,
          tokenEndpoint: d.tokenEndpoint,
          ...(d.revocationEndpoint ? { revocationEndpoint: d.revocationEndpoint } : {}),
          clientId: client.clientId,
          ...(client.clientSecret ? { clientSecret: client.clientSecret } : {}),
          authMethod: client.authMethod,
          ...(t.scope ?? scope ? { scope: (t.scope ?? scope)! } : {}),
          accessToken: t.accessToken,
          ...(t.refreshToken ? { refreshToken: t.refreshToken } : {}),
          ...(t.expiresAt ? { expiresAt: t.expiresAt } : {}),
        }
        await save(opts.id, rec)
        resolveDone()
      } catch (e) {
        rejectDone(e as Error)
        throw e
      }
    }

    server.on('request', (req, res) => {
      const u = new URL(req.url ?? '/', `http://127.0.0.1:${port}`)
      const host = req.headers.host ?? ''
      if (u.pathname !== '/callback' || req.method !== 'GET' || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) {
        res.writeHead(404).end()
        return
      }
      inflight++
      const reply = (status: number, title: string, text: string): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE(title, text), () => {
          inflight--
          maybeClose()
        })
      }
      finish(u.searchParams).then(
        () => reply(200, 'Signed in', 'You can close this tab and go back to VARA.'),
        () => reply(400, 'Sign-in did not work', 'Go back to VARA for the reason.'),
      )
    })
    timer = setTimeout(() => fail(new Error('the sign-in was not completed within 5 minutes')), LOGIN_TIMEOUT_MS)
    timer.unref?.()
    return {
      authUrl: url.toString(),
      redirectUri,
      done,
      submitPasted: (pasted) => finish(parsePasted(pasted)),
      cancel: () => fail(new Error('cancelled')),
    }
  } catch (err) {
    closeAll()
    throw err
  }
}
