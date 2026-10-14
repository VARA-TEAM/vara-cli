import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { PRESETS, presetGrant, type Grant, type GrantPreset, type Principal } from './access.js'
import type { StampedEvent, VaraHost } from './host.js'
import { VERSION } from '../version.js'
import { uiAssets } from './ui-assets.js'

/**
 * The local HTTP API of a VARA host: REST for commands, Server-Sent Events for
 * live output. Dependency-free on purpose.
 *
 * Threat model: this process can run commands on the owner's machine, so the
 * server is hardened as such —
 *   • binds to 127.0.0.1 unless the owner explicitly opens it to the LAN;
 *   • every API call needs a secret bearer token (the owner's, or a guest's);
 *   • the Host header must be one we expect (defeats DNS rebinding) and any
 *     browser Origin must match it (defeats cross-site requests);
 *   • failed logins and invite attempts are rate limited per address;
 *   • bodies are size limited, responses are never cached or sniffed.
 */

export interface ServerOptions {
  host: VaraHost
  /** Secret that identifies the OWNER. Generate with newOwnerToken(). */
  ownerToken: string
  bind?: string
  port?: number
  /** Extra hostnames clients may use (e.g. a tunnel's), besides localhost and private IPs. */
  allowedHosts?: string[]
  /** HTML served at / and /join/*. */
  page?: string
  /** Called with unexpected server errors (never sent to clients). */
  onError?: (err: unknown) => void
  /**
   * The address guests should use in invite links (LAN IP or tunnel host). Read per request:
   * the port is only known after the server starts. Without it, links use the address the owner
   * is browsing with — which is 127.0.0.1 when they sit at the host itself, useless to a phone.
   */
  publicUrl?: () => string | undefined
  /** Attempt limits per address and 5 minutes (defaults: 10 failed logins, 20 invite tries). */
  limits?: { failures?: number; joins?: number }
  /** Assets served under /assets/ (name → {type, body}). */
  assets?: Record<string, { type: string; body: string | Buffer }>
}

export interface RunningServer {
  port: number
  bind: string
  close(): Promise<void>
}

export const newOwnerToken = (): string => randomBytes(32).toString('base64url')

const MAX_BODY = 1_000_000
const sha = (s: string): Buffer => createHash('sha256').update(s).digest()

function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(sha(a), sha(b))
}

/** hostname part of a Host header, without port; keeps IPv6 brackets off. */
function hostnameOf(hostHeader: string | undefined): string {
  if (!hostHeader) return ''
  const h = hostHeader.trim().toLowerCase()
  if (h.startsWith('[')) return h.slice(1, h.indexOf(']'))
  return h.split(':')[0] ?? ''
}

const PRIVATE_IPV4 = /^(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+)$/

export function hostAllowed(hostHeader: string | undefined, lan: boolean, extra: string[]): boolean {
  const name = hostnameOf(hostHeader)
  if (!name) return false
  if (name === 'localhost' || name === '127.0.0.1' || name === '::1') return true
  if (extra.map((e) => e.toLowerCase()).includes(name)) return true
  // On the LAN, devices type the machine's private IP. A DOMAIN name is refused: that is what rebinding uses.
  return lan && PRIVATE_IPV4.test(name)
}

class RateLimit {
  private hits = new Map<string, number[]>()
  constructor(private readonly max: number, private readonly windowMs: number) {}
  /** True when the address already used up its allowance (without recording anything). */
  blocked(key: string, now = Date.now()): boolean {
    return (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs).length >= this.max
  }

  /** Record an attempt; false when the address is over its limit. */
  hit(key: string, now = Date.now()): boolean {
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs)
    list.push(now)
    this.hits.set(key, list)
    if (this.hits.size > 5_000) for (const [k, v] of this.hits) if (!v.some((t) => now - t < this.windowMs)) this.hits.delete(k)
    return list.length <= this.max
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const bind = opts.bind ?? '127.0.0.1'
  const lan = bind !== '127.0.0.1' && bind !== 'localhost' && bind !== '::1'
  const extraHosts = opts.allowedHosts ?? []
  const host = opts.host
  const failures = new RateLimit(opts.limits?.failures ?? 10, 5 * 60_000)
  const joins = new RateLimit(opts.limits?.joins ?? 20, 5 * 60_000)

  const json = (res: ServerResponse, status: number, body: unknown): void => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }

  const principalOf = (req: IncomingMessage, url: URL): { principal: Principal; token: string } | null => {
    const auth = req.headers.authorization
    let token = auth?.startsWith('Bearer ') ? auth.slice(7).trim() : ''
    // EventSource cannot set headers; allow the token in the query for the event stream only.
    if (!token && url.pathname.endsWith('/events')) token = url.searchParams.get('access_token') ?? ''
    if (!token) return null
    if (safeEqual(token, opts.ownerToken)) return { principal: { kind: 'owner' }, token }
    const guest = host.access.authenticate(token)
    if (!guest) return null
    host.access.touch(guest.id)
    return { principal: guest, token }
  }

  const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const type = req.headers['content-type'] ?? ''
      let size = 0
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => {
        size += c.length
        if (size > MAX_BODY) {
          reject(new HttpError(413, 'request too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        if (size === 0) return resolve({})
        if (!type.includes('application/json')) return reject(new HttpError(415, 'send JSON'))
        try {
          const v = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
          resolve(v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})
        } catch {
          reject(new HttpError(400, 'invalid JSON'))
        }
      })
      req.on('error', reject)
    })

  const str = (v: unknown, max = 20_000): string => (typeof v === 'string' ? v.slice(0, max) : '')

  const origin = (req: IncomingMessage): string => `http://${req.headers.host ?? ''}`

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    res.setHeader('x-content-type-options', 'nosniff')
    res.setHeader('referrer-policy', 'no-referrer')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('x-frame-options', 'DENY')
    res.setHeader('content-security-policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")

    // DNS rebinding: refuse any Host we did not expect.
    if (!hostAllowed(req.headers.host, lan, extraHosts)) return json(res, 421, { error: 'unexpected host' })

    const url = new URL(req.url ?? '/', origin(req))
    const method = req.method ?? 'GET'
    const ip = req.socket.remoteAddress ?? 'unknown'

    // Cross-site requests: a browser always sends Origin on POST/PUT/PATCH/DELETE.
    if (method !== 'GET' && method !== 'HEAD') {
      const o = req.headers.origin
      if (o && o !== origin(req) && o !== origin(req).replace('http:', 'https:')) return json(res, 403, { error: 'cross-origin request refused' })
    }

    /* ---- the page ---- */
    if (method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/join/'))) {
      const page = opts.page ?? uiAssets.html ?? PLACEHOLDER_PAGE
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return void res.end(page)
    }
    if (method === 'GET' && url.pathname.startsWith('/assets/')) {
      const name = url.pathname.slice('/assets/'.length)
      const a = opts.assets?.[name] ?? uiAssets.files[name]
      if (!a) return json(res, 404, { error: 'not found' })
      // Revalidate every time: a new VARA version must never be paired with an old page.
      res.writeHead(200, { 'content-type': a.type, 'cache-control': 'no-cache' })
      return void res.end(a.body)
    }

    /* ---- public API ---- */
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'vara', version: VERSION })
    if (url.pathname === '/api/join' && method === 'POST') {
      if (!joins.hit(ip)) return json(res, 429, { error: 'too many attempts, try again later' })
      const body = await readBody(req)
      const result = host.access.redeem(str(body['invite'], 200), str(body['name'], 80))
      if ('error' in result) {
        failures.hit(ip)
        return json(res, 400, { error: result.error })
      }
      return json(res, 200, { accessToken: result.accessToken, guest: { id: result.guest.id, name: result.guest.name, grant: result.guest.grant } })
    }
    if (!url.pathname.startsWith('/api/')) return json(res, 404, { error: 'not found' })

    /* ---- everything else needs a token ---- */
    if (failures.blocked(ip)) return json(res, 429, { error: 'too many failed attempts, try again later' })
    const who = principalOf(req, url)
    if (!who) {
      failures.hit(ip)
      return json(res, 401, { error: 'unauthorized' })
    }
    const p = who.principal
    const parts = url.pathname.split('/').filter(Boolean) // ['api', ...]
    const [, a, b, c] = parts

    const reply = <T>(r: { ok: true; value: T } | { ok: false; status: number; error: string }): void =>
      r.ok ? json(res, 200, r.value) : json(res, r.status, { error: r.error })

    if (a === 'me' && method === 'GET') {
      const info = host.info(p)
      return json(res, 200, p.kind === 'owner' ? { role: 'owner', name: 'owner', host: info } : { role: 'guest', id: p.id, name: p.name, grant: host.access.getGuest(p.id)?.grant ?? p.grant, host: info })
    }
    if (a === 'models' && method === 'GET') return json(res, 200, host.models(p))

    /* ---- sessions ---- */
    if (a === 'sessions') {
      if (!b && method === 'GET') return reply(await host.list(p))
      if (!b && method === 'POST') {
        const body = await readBody(req)
        const kind = body['kind'] === 'task' || body['kind'] === 'goal' || body['kind'] === 'auto' ? body['kind'] : undefined
        const mode = body['mode'] === 'plan' || body['mode'] === 'build' ? body['mode'] : undefined
        return reply(await host.create(p, { message: str(body['message']), ...(mode ? { mode } : {}), ...(kind ? { kind } : {}), ...(typeof body['model'] === 'string' ? { model: str(body['model'], 200) } : {}) }))
      }
      if (b && !c && method === 'GET') return reply(await host.get(p, b))
      if (b && c === 'messages' && method === 'POST') return reply(await host.send(p, b, str((await readBody(req))['text'])))
      if (b && c === 'pause' && method === 'POST') return reply(await host.pause(p, b))
      if (b && c === 'mode' && method === 'POST') {
        const mode = (await readBody(req))['mode']
        if (mode !== 'plan' && mode !== 'build') return json(res, 400, { error: 'mode must be plan or build' })
        return reply(await host.setMode(p, b, mode))
      }
      if (b && c === 'model' && method === 'POST') return reply(await host.setModel(p, b, str((await readBody(req))['model'], 200)))
      if (b && c === 'share' && method === 'POST') return reply(await host.share(p, b, (await readBody(req))['shared'] === true))
      if (b && c === 'events' && method === 'GET') return sse(req, res, url, who.token, p, b)
    }

    /* ---- owner administration ---- */
    if (a === 'admin') {
      if (p.kind !== 'owner') return json(res, 403, { error: 'only the owner can do that' })
      if (b === 'overview' && method === 'GET') return reply(await host.overview(p))
      if (b === 'invites' && method === 'GET') return json(res, 200, host.access.listInvites())
      if (b === 'invites' && method === 'POST') {
        const body = await readBody(req)
        const preset = (str(body['preset'], 20) || 'participant') as GrantPreset
        if (!(preset in PRESETS)) return json(res, 400, { error: `preset must be one of ${Object.keys(PRESETS).join(', ')}` })
        const grant = presetGrant(preset, sanitizeGrant(body['grant']))
        const ttlMin = typeof body['ttlMinutes'] === 'number' && body['ttlMinutes'] > 0 ? Math.min(body['ttlMinutes'], 60 * 24 * 30) : 24 * 60
        const invite = host.access.createInvite(grant, {
          label: str(body['label'], 60),
          ttlMs: ttlMin * 60_000,
          maxUses: typeof body['maxUses'] === 'number' ? Math.max(1, Math.min(100, Math.floor(body['maxUses']))) : 1,
        })
        return json(res, 200, { id: invite.id, expiresAt: invite.expiresAt, token: invite.token, link: `${opts.publicUrl?.() ?? origin(req)}/join/${invite.token}`, grant })
      }
      if (b === 'invites' && c && method === 'DELETE') return json(res, host.access.revokeInvite(c) ? 200 : 404, { ok: true })
      if (b === 'guests' && method === 'GET') return json(res, 200, host.access.listGuests())
      if (b === 'guests' && c && method === 'PATCH') {
        const grant = host.access.updateGrant(c, sanitizeGrant((await readBody(req))['grant']))
        if (!grant) return json(res, 404, { error: 'no such guest' })
        return json(res, 200, grant)
      }
      if (b === 'guests' && c && method === 'DELETE') {
        const ok = host.access.revokeGuest(c)
        if (ok) host.disconnectGuest(c)
        return json(res, ok ? 200 : 404, { ok })
      }
    }
    return json(res, 404, { error: 'not found' })
  }

  const sse = async (req: IncomingMessage, res: ServerResponse, url: URL, token: string, p: Principal, id: string): Promise<void> => {
    const after = Number(url.searchParams.get('after') ?? req.headers['last-event-id'] ?? 0) || 0
    let closed = false
    const timers: Array<ReturnType<typeof setInterval>> = []
    const finish = (): void => {
      if (closed) return
      closed = true
      for (const t of timers) clearInterval(t)
      unsub?.()
      try {
        res.end()
      } catch {
        /* gone */
      }
    }
    let unsub: (() => void) | undefined
    const write = (e: StampedEvent): void => {
      if (closed) return
      res.write(`id: ${e.id}\ndata: ${JSON.stringify({ at: e.at, ...e.event })}\n\n`)
    }
    const sub = await host.subscribe(p, id, after, { send: write, close: finish })
    if (!sub.ok) return json(res, sub.status, { error: sub.error })
    unsub = sub.value.unsubscribe
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    })
    res.write(': connected\n\n')
    for (const e of sub.value.backlog) write(e)
    timers.push(setInterval(() => !closed && res.write(': ping\n\n'), 15_000))
    // A guest revoked or expired mid-stream is cut off within seconds.
    if (p.kind === 'guest') {
      timers.push(
        setInterval(() => {
          if (!host.access.authenticate(token)) {
            write({ id: Date.now(), at: new Date().toISOString(), event: { type: 'revoked' } })
            finish()
          }
        }, 5_000),
      )
    }
    req.on('close', finish)
  }

  const server: Server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      if (res.headersSent) return void res.end()
      if (err instanceof HttpError) return json(res, err.status, { error: err.message })
      // Never leak internals (paths, stack traces) to a client — but do tell the owner.
      opts.onError?.(err)
      json(res, 500, { error: 'internal error' })
    })
  })
  // SSE connections are long-lived: no request timeout on the server.
  server.requestTimeout = 0
  server.headersTimeout = 20_000

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, bind, resolve)
  })
  const port = (server.address() as AddressInfo).port
  const sweeper = setInterval(() => host.sweepRevoked(), 5_000)
  sweeper.unref()
  return {
    port,
    bind,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(sweeper)
        server.closeAllConnections?.()
        server.close(() => resolve())
      }),
  }
}

/** Only known grant fields, with the right types — an owner's typo must not corrupt the file. */
export function sanitizeGrant(raw: unknown): Partial<Grant> {
  if (!raw || typeof raw !== 'object') return {}
  const r = raw as Record<string, unknown>
  const out: Partial<Grant> = {}
  for (const k of ['watch', 'sendShared', 'ownSession', 'canChangeMode', 'canInterrupt'] as const) if (typeof r[k] === 'boolean') out[k] = r[k] as boolean
  if (r['mode'] === 'plan' || r['mode'] === 'build') out.mode = r['mode']
  if (r['modelPolicy'] === 'locked' || r['modelPolicy'] === 'list' || r['modelPolicy'] === 'any') out.modelPolicy = r['modelPolicy']
  if (Array.isArray(r['allowedModels'])) out.allowedModels = r['allowedModels'].filter((m): m is string => typeof m === 'string').slice(0, 50)
  if (typeof r['maxModelCalls'] === 'number') out.maxModelCalls = Math.floor(r['maxModelCalls'])
  if (typeof r['maxCostUsd'] === 'number') out.maxCostUsd = r['maxCostUsd']
  if (typeof r['expiresAt'] === 'string' && !Number.isNaN(Date.parse(r['expiresAt']))) out.expiresAt = r['expiresAt']
  return out
}

const PLACEHOLDER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>VARA</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh;margin:0"><div><h1 style="color:#F2A65A">VARA</h1><p>The host is running. The web interface is not installed in this build.</p></div></body></html>`
