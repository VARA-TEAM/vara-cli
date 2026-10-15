import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect, createServer as createNetServer, type Socket } from 'node:net'
import { scrubAll } from '../security/redact.js'

/**
 * Live preview: the agent (or the owner) starts the project's dev server, and
 * VARA fronts it with a reverse proxy bound to 127.0.0.1 on its OWN port. The
 * web UI shows that port in a sandboxed iframe; the TUI prints the URL.
 *
 * Why a separate port and not a path under the host: dev servers use
 * root-absolute URLs (/assets/app.js, /@vite/client, websockets for hot
 * reload), which only work at the root of an origin. A distinct port is also a
 * distinct origin, so the previewed app can never touch VARA's page or token.
 *
 * Safety: loopback only, `Host` is checked (DNS rebinding), framing is limited
 * to VARA's own page, and nothing here is reachable by guests or through a
 * share tunnel. Output is scrubbed like every other tool output.
 */

export type PreviewState = 'starting' | 'running' | 'stopped' | 'failed'

export interface PreviewInfo {
  sessionId: string
  command: string
  cwd: string
  state: PreviewState
  /** Where VARA's proxy listens (what to open / embed). */
  url?: string
  /** The dev server's own port. */
  port?: number
  startedAt: string
  exitCode?: number | null
  error?: string
}

export interface PreviewDeps {
  spawn?: typeof spawn
  /** How long to wait for the server to start listening. */
  startTimeoutMs?: number
  pollMs?: number
}

const MAX_PREVIEWS = 3
const MAX_LOG_LINES = 500
const URL_IN_LOG = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]):(\d{2,5})/i

interface Entry {
  info: PreviewInfo
  child: ChildProcess | null
  log: string[]
  proxy: Server | null
  sockets: Set<Socket>
  target: { host: string; port: number } | null
  /** Resolves the start wait early (process died). */
  died: boolean
}

export class PreviewManager {
  private entries = new Map<string, Entry>()
  private listeners = new Set<() => void>()
  private ancestors: string[] = []

  constructor(private readonly deps: PreviewDeps = {}) {}

  /** Origins allowed to embed a preview (VARA's own page). Without any, previews cannot be framed. */
  setFrameAncestors(origins: string[]): void {
    this.ancestors = origins
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    for (const l of this.listeners) l()
  }

  get(sessionId: string): PreviewInfo | null {
    return this.entries.get(sessionId)?.info ?? null
  }

  logs(sessionId: string, lines = 60): string {
    const e = this.entries.get(sessionId)
    return e ? e.log.slice(-lines).join('\n') : ''
  }

  list(): PreviewInfo[] {
    return [...this.entries.values()].map((e) => e.info)
  }

  /** Start the dev server for a session (replacing a running one) and wait until it answers. */
  async start(sessionId: string, opts: { command: string; cwd: string; env?: Record<string, string>; port?: number }): Promise<PreviewInfo> {
    await this.stop(sessionId)
    const live = [...this.entries.values()].filter((e) => e.info.state === 'starting' || e.info.state === 'running').length
    if (live >= MAX_PREVIEWS) throw new Error(`at most ${MAX_PREVIEWS} previews can run at once — stop one first`)

    const port = opts.port ?? (await freePort())
    const command = opts.command.split('{port}').join(String(port))
    const entry: Entry = {
      info: { sessionId, command, cwd: opts.cwd, state: 'starting', startedAt: new Date().toISOString() },
      child: null,
      log: [],
      proxy: null,
      sockets: new Set(),
      target: null,
      died: false,
    }
    this.entries.set(sessionId, entry)
    this.changed()

    const isWin = process.platform === 'win32'
    const env = { ...(opts.env ?? process.env), PORT: String(port), BROWSER: 'none', FORCE_COLOR: '0' } as Record<string, string>
    const run = this.deps.spawn ?? spawn
    const child = isWin
      ? run('cmd.exe', ['/d', '/s', '/c', command], { cwd: opts.cwd, env, windowsHide: true, windowsVerbatimArguments: true })
      : run('bash', ['-lc', command], { cwd: opts.cwd, env, detached: true })
    entry.child = child
    const take = (d: Buffer): void => {
      for (const line of scrubAll(d.toString('utf8')).split(/\r?\n/)) {
        if (!line.trim()) continue
        entry.log.push(line.slice(0, 500))
        if (entry.log.length > MAX_LOG_LINES) entry.log.shift()
        const m = URL_IN_LOG.exec(line)
        if (m) detected = Number(m[1])
      }
    }
    let detected: number | null = null
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.on('error', (err) => {
      entry.died = true
      entry.info.state = 'failed'
      entry.info.error = scrubAll(err.message)
      this.changed()
    })
    child.on('close', (code) => {
      entry.died = true
      entry.info.exitCode = code
      if (entry.info.state !== 'stopped') entry.info.state = entry.info.state === 'running' ? 'stopped' : 'failed'
      if (entry.info.state === 'failed' && !entry.info.error) entry.info.error = `the command exited (code ${code}) before a server started listening`
      void this.closeProxy(entry)
      this.changed()
    })

    // Wait until something answers on the assigned port or the one the server announced.
    const deadline = Date.now() + (this.deps.startTimeoutMs ?? 60_000)
    const poll = this.deps.pollMs ?? 250
    while (Date.now() < deadline && !entry.died) {
      for (const candidate of [port, detected]) {
        if (!candidate) continue
        const host = await probe(candidate)
        if (host) {
          entry.target = { host, port: candidate }
          entry.info.port = candidate
          break
        }
      }
      if (entry.target) break
      await new Promise((r) => setTimeout(r, poll))
    }
    if (!entry.target) {
      if (!entry.died) {
        entry.info.state = 'failed'
        entry.info.error = `nothing listened on port ${port} within ${Math.round((this.deps.startTimeoutMs ?? 60_000) / 1000)}s. The server must read the PORT environment variable (or use {port} in the command).`
        await this.stop(sessionId, true)
      }
      this.changed()
      return entry.info
    }
    entry.proxy = await this.listen(entry)
    const addr = entry.proxy.address()
    entry.info.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/`
    entry.info.state = 'running'
    this.changed()
    return entry.info
  }

  /** Stop a session's preview: the process tree and the proxy. Keeps the record (state `stopped`) unless `forget`. */
  async stop(sessionId: string, keepFailed = false): Promise<void> {
    const e = this.entries.get(sessionId)
    if (!e) return
    if (e.info.state !== 'failed') e.info.state = 'stopped'
    await this.closeProxy(e)
    killTree(e.child)
    e.child = null
    if (!keepFailed) this.entries.delete(sessionId)
    this.changed()
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.entries.keys()]) await this.stop(id)
  }

  private async closeProxy(e: Entry): Promise<void> {
    for (const s of e.sockets) s.destroy()
    e.sockets.clear()
    const p = e.proxy
    e.proxy = null
    if (p) await new Promise<void>((r) => p.close(() => r()))
  }

  /* ---------- the reverse proxy ---------- */

  private async listen(entry: Entry): Promise<Server> {
    const target = entry.target!
    const server = createServer((req, res) => this.forward(entry, server, req, res))
    server.on('upgrade', (req, socket, head) => this.tunnel(entry, server, req, socket as Socket, head))
    server.on('connection', (s) => {
      entry.sockets.add(s)
      s.on('close', () => entry.sockets.delete(s))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    void target
    return server
  }

  /** Only our own loopback name:port may talk to the proxy (a DNS-rebinding page would send another Host). */
  private hostOk(server: Server, host: string | undefined): boolean {
    const a = server.address()
    if (!a || typeof a === 'string' || !host) return false
    return host === `127.0.0.1:${a.port}` || host === `localhost:${a.port}`
  }

  private forward(entry: Entry, server: Server, req: IncomingMessage, res: ServerResponse): void {
    if (!this.hostOk(server, req.headers.host)) {
      res.writeHead(421, { 'content-type': 'text/plain' })
      return void res.end('unexpected host')
    }
    const t = entry.target!
    const headers = { ...req.headers, host: `${t.host === '::1' ? '[::1]' : t.host}:${t.port}` } as Record<string, string | string[] | undefined>
    if (typeof headers['origin'] === 'string') headers['origin'] = `http://${headers['host']}`
    if (typeof headers['referer'] === 'string') headers['referer'] = `http://${headers['host']}/`
    const up = httpRequest({ host: t.host, port: t.port, method: req.method, path: req.url, headers }, (ur) => {
      const out = { ...ur.headers }
      delete out['x-frame-options']
      const csp = out['content-security-policy']
      if (csp) out['content-security-policy'] = (Array.isArray(csp) ? csp : [csp]).map((c) => c.replace(/(^|;)\s*frame-ancestors[^;]*/gi, '$1').trim()).filter(Boolean)
      const mine = `frame-ancestors ${this.ancestors.length ? this.ancestors.join(' ') : "'none'"}`
      const prev = out['content-security-policy']
      out['content-security-policy'] = [...(Array.isArray(prev) ? prev : prev ? [prev] : []), mine]
      out['cache-control'] = out['cache-control'] ?? 'no-store'
      res.writeHead(ur.statusCode ?? 502, out)
      ur.pipe(res)
    })
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' })
      res.end('the dev server did not answer')
    })
    req.pipe(up)
  }

  /** Websockets (hot reload): relay the upgrade as raw bytes. */
  private tunnel(entry: Entry, server: Server, req: IncomingMessage, socket: Socket, head: Buffer): void {
    if (!this.hostOk(server, req.headers.host)) return void socket.destroy()
    const t = entry.target!
    const up = connect(t.port, t.host, () => {
      const headers = { ...req.headers, host: `${t.host === '::1' ? '[::1]' : t.host}:${t.port}` } as Record<string, string | string[] | undefined>
      if (typeof headers['origin'] === 'string') headers['origin'] = `http://${headers['host']}`
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) lines.push(`${k}: ${one}`)
      up.write(lines.join('\r\n') + '\r\n\r\n')
      if (head.length) up.write(head)
      up.pipe(socket)
      socket.pipe(up)
    })
    entry.sockets.add(socket)
    entry.sockets.add(up)
    const drop = (): void => {
      socket.destroy()
      up.destroy()
    }
    up.on('error', drop)
    socket.on('error', drop)
    socket.on('close', () => up.destroy())
  }
}

/** A port nobody listens on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createNetServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a ? a.port : 0
      s.close(() => resolve(port))
    })
  })
}

/** Which loopback address accepts connections on this port (IPv4 first, then IPv6), or null. */
function probe(port: number): Promise<string | null> {
  const one = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const s = connect({ port, host, timeout: 400 })
      s.once('connect', () => (s.destroy(), resolve(true)))
      s.once('timeout', () => (s.destroy(), resolve(false)))
      s.once('error', () => resolve(false))
    })
  return one('127.0.0.1').then((ok) => (ok ? '127.0.0.1' : one('::1').then((ok6) => (ok6 ? '::1' : null))))
}

function killTree(child: ChildProcess | null): void {
  if (!child || child.pid === undefined || child.exitCode !== null) return
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    else process.kill(-child.pid, 'SIGTERM')
  } catch {
    try {
      child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }
}

/** The one manager of this process (the host, the TUI and the agent's tool share it). */
export const previews = new PreviewManager()
