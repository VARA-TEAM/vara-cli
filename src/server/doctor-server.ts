import { createServer } from 'node:net'
import { accessSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLoopback, ownerDigestFile, parseServeSettings, tokenProblem, type Env, type ServeSettings } from './daemon.js'

/**
 * `vara doctor --server`: the questions to ask BEFORE leaving VARA running unattended — can it write its data,
 * is the port free, how exposed is it, is there a token, can the proxy and TLS be reached. Every probe is
 * injectable, so the logic is tested without a network or a second process.
 */

export interface ServerCheck {
  name: string
  ok: boolean
  /** Not fatal: shown as "todo". */
  optional?: boolean
  detail: string
}

export interface ServerProbes {
  home: string
  hostDir: string
  /** Can we listen on bind:port right now? */
  portFree(bind: string, port: number): Promise<boolean>
  /** GET <url>/api/health through the real network path (proxy, TLS). */
  health(url: string): Promise<{ ok: boolean; detail: string }>
  /** Is a process with this pid alive? */
  alive(pid: number): boolean
  /** The web interface is built into this build. */
  uiBuilt(): boolean
  providerKey(): Promise<{ ok: boolean; detail: string }>
  inContainer(): boolean
}

export const realProbes = (home: string, hostDir: string, extra: Pick<ServerProbes, 'uiBuilt' | 'providerKey'>): ServerProbes => ({
  home,
  hostDir,
  portFree: (bind, port) =>
    new Promise((resolve) => {
      const s = createServer()
      s.once('error', () => resolve(false))
      s.listen(port, bind, () => s.close(() => resolve(true)))
    }),
  health: async (url) => {
    try {
      const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(6_000) })
      const body = (await r.json().catch(() => ({}))) as { name?: string; version?: string }
      return r.ok && body.name === 'vara' ? { ok: true, detail: `${url} answers (VARA ${body.version ?? '?'})` } : { ok: false, detail: `${url}/api/health answered ${r.status}, not VARA` }
    } catch (err) {
      return { ok: false, detail: `${url}/api/health is not reachable: ${(err as Error).message}` }
    }
  },
  alive: (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  },
  inContainer: () => existsSync('/.dockerenv') || !!process.env['KUBERNETES_SERVICE_HOST'],
  ...extra,
})

function writable(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true })
    const probe = join(dir, `.doctor-${process.pid}`)
    writeFileSync(probe, 'x')
    rmSync(probe)
    accessSync(dir, constants.W_OK)
    return null
  } catch (err) {
    return (err as NodeJS.ErrnoException).code ?? (err as Error).message
  }
}

export async function serverChecks(args: string[], env: Env, p: ServerProbes, opts: { checkPublic?: boolean } = {}): Promise<ServerCheck[]> {
  const out: ServerCheck[] = []
  let s: ServeSettings
  try {
    s = parseServeSettings(args, env, { daemon: true })
  } catch (err) {
    return [{ name: 'Settings', ok: false, detail: (err as Error).message }]
  }
  out.push({ name: 'Settings', ok: true, detail: `listen ${s.bind}:${s.port}${s.publicHost ? `, public host ${s.publicHost}` : ''}, folder ${s.cwd}, log ${s.log}${s.trustProxy ? ', trusting the proxy' : ''}` })

  const bad = writable(p.home)
  out.push({ name: 'Data folder', ok: !bad, detail: bad ? `${p.home} is not writable (${bad}) — VARA_HOME must be a folder the service user owns` : `${p.home} is writable` })
  if (!existsSync(s.cwd)) out.push({ name: 'Work folder', ok: false, detail: `${s.cwd} does not exist (--cwd / VARA_CWD)` })
  else out.push({ name: 'Work folder', ok: true, detail: `${s.cwd}${existsSync(join(s.cwd, '.git')) ? ' (a git repository)' : ' (not a git repository: diffs and commits will not work)'}` })

  // Is something already running from this data folder?
  let running: { pid?: number; port?: number } | null = null
  try {
    running = JSON.parse(readFileSync(join(p.hostDir, 'running.json'), 'utf8')) as { pid?: number; port?: number }
  } catch {
    /* none */
  }
  if (running?.pid && p.alive(running.pid)) {
    out.push({ name: 'Running host', ok: true, optional: true, detail: `a host from this data folder is already running (pid ${running.pid}, port ${running.port ?? '?'})` })
  } else {
    const free = s.port === 0 ? true : await p.portFree(s.bind, s.port)
    out.push({ name: 'Port', ok: free, detail: free ? `${s.bind}:${s.port} is free` : `${s.bind}:${s.port} is already in use — pick another with --port / VARA_PORT, or stop what uses it` })
  }

  if (!isLoopback(s.bind)) {
    out.push({
      name: 'Exposure',
      ok: !!s.publicHost || p.inContainer(),
      optional: true,
      detail: `listening on ${s.bind}: reachable from other machines. ${s.publicHost ? `Put TLS in front (${s.publicHost}) and keep the port itself firewalled.` : p.inContainer() ? 'In a container this is normal: publish the port on 127.0.0.1 only (-p 127.0.0.1:7777:7777) or behind your proxy.' : 'No --public-host and no TLS: use a reverse proxy, or bind to 127.0.0.1.'}`,
    })
  } else out.push({ name: 'Exposure', ok: true, detail: `loopback only (${s.bind}): only this machine, or a reverse proxy on it, can connect` })

  // The owner token.
  if (s.tokenFile) {
    try {
      const t = readFileSync(s.tokenFile, 'utf8').trim()
      const problem = tokenProblem(t)
      out.push({ name: 'Owner token', ok: !problem, detail: problem ? `${s.tokenFile}: ${problem}` : `read from ${s.tokenFile}` })
    } catch (err) {
      out.push({ name: 'Owner token', ok: false, detail: `cannot read ${s.tokenFile}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}` })
    }
  } else if (s.token !== undefined) {
    out.push({ name: 'Owner token', ok: true, detail: `provided through ${s.tokenFrom === 'flag' ? '--token (visible in the process list: prefer a file)' : 'VARA_OWNER_TOKEN'}` })
  } else {
    const file = ownerDigestFile(p.hostDir)
    out.push({ name: 'Owner token', ok: true, optional: !existsSync(file), detail: existsSync(file) ? `a token was made earlier (only its hash is stored in ${file}); \`--rotate-token\` replaces it` : 'none yet: the first `vara serve` makes one and prints the login link ONCE' })
    if (existsSync(file) && process.platform !== 'win32') {
      const mode = statSync(file).mode & 0o777
      if (mode & 0o077) out.push({ name: 'Token file mode', ok: false, optional: true, detail: `${file} is mode ${mode.toString(8)}; run: chmod 600 ${file}` })
    }
  }

  const key = await p.providerKey()
  out.push({ name: 'Provider', ok: key.ok, detail: key.detail })
  out.push({ name: 'Interface', ok: p.uiBuilt(), detail: p.uiBuilt() ? 'the web interface is built in' : 'this build has no web interface (run `npm run build:ui`)' })

  if (s.publicHost) {
    if (!s.trustProxy) out.push({ name: 'Proxy', ok: false, optional: true, detail: 'a public host is set but --trust-proxy (VARA_TRUST_PROXY=1) is not: every visitor would look like your proxy to the login rate limit' })
    if (opts.checkPublic !== false) {
      const h = await p.health(`https://${s.publicHost}`)
      out.push({ name: 'Public URL', ok: h.ok, optional: true, detail: h.ok ? h.detail : `${h.detail} (is the host running, and is the proxy forwarding to ${s.bind}:${s.port}? see docs/DEPLOYMENT.md)` })
    }
  }
  if (p.inContainer() && isLoopback(s.bind)) out.push({ name: 'Container', ok: false, detail: 'inside a container the host listens on 127.0.0.1, so the published port cannot reach it — use --bind 0.0.0.0 (VARA_BIND) and publish the port on 127.0.0.1 only' })
  return out
}
