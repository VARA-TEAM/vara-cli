import { spawn, type ChildProcess } from 'node:child_process'
import { scrubAll } from '../security/redact.js'

/**
 * Temporary public share links. VARA runs NO relay of its own: it starts an
 * outbound tunnel with a tool the owner already has, reads the public URL the
 * tool prints, and tears the tunnel down when the host closes.
 *
 * A tunnel provider is only a recipe: which binary, which arguments, and how
 * to recognise the public URL in its output. Adding one is a few lines.
 * Process and lookup dependencies are injected so everything is testable
 * without a network.
 */

export interface TunnelProvider {
  id: string
  label: string
  binary: string
  /** Arguments that expose 127.0.0.1:<port>. */
  args(port: number, opts: TunnelOptions): string[]
  /** Matches the public https URL in the tool's output (first capture group = the URL). */
  urlPattern: RegExp
  install: string
}

export interface TunnelOptions {
  /** ssh provider: the relay to forward through (default: localhost.run). */
  sshHost?: string
}

export interface TunnelDeps {
  spawn?: typeof spawn
  /** Is this program installed? */
  has?: (binary: string) => Promise<boolean>
  /** How long to wait for the URL. */
  timeoutMs?: number
}

export interface Tunnel {
  provider: string
  /** https URL guests use. */
  url: string
  /** Its host name, for the Host-header allow-list. */
  host: string
  close(): Promise<void>
  /** Resolves when the tunnel ends on its own (or after close), with the last line it printed. */
  ended: Promise<string>
}

export const PROVIDERS: TunnelProvider[] = [
  {
    id: 'cloudflared',
    label: 'Cloudflare quick tunnel',
    binary: 'cloudflared',
    args: (port) => ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`],
    urlPattern: /(https:\/\/[a-z0-9-]+\.trycloudflare\.com)/i,
    install: 'install cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/',
  },
  {
    id: 'ssh',
    label: 'SSH reverse tunnel (localhost.run)',
    binary: 'ssh',
    args: (port, o) => ['-T', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ServerAliveInterval=30', '-o', 'ExitOnForwardFailure=yes', '-R', `80:127.0.0.1:${port}`, `nokey@${o.sshHost ?? 'localhost.run'}`],
    // the relay prints "... tunneled with tls termination, https://<id>.lhr.life"; skip its admin/docs links
    urlPattern: /(https:\/\/(?!admin\.|localhost\.run|www\.)[a-z0-9-]+\.(?:lhr\.life|localhost\.run|serveo\.net|serveousercontent\.com))/i,
    install: 'ssh is part of OpenSSH (Windows 10+ has it as an optional feature; macOS and Linux ship it)',
  },
]

const defaultHas = (binary: string): Promise<boolean> =>
  new Promise((resolve) => {
    const c = spawn(process.platform === 'win32' ? 'where' : 'which', [binary], { stdio: 'ignore', windowsHide: true })
    c.on('error', () => resolve(false))
    c.on('close', (code) => resolve(code === 0))
  })

/** Which providers are installed here, in order of preference. */
export async function availableProviders(deps: TunnelDeps = {}): Promise<TunnelProvider[]> {
  const has = deps.has ?? defaultHas
  const found: TunnelProvider[] = []
  for (const p of PROVIDERS) if (await has(p.binary)) found.push(p)
  return found
}

/** Pick a provider by name (or the best installed one for `auto`), with a clear error when none works. */
export async function pickProvider(want: string, deps: TunnelDeps = {}): Promise<TunnelProvider> {
  const have = await availableProviders(deps)
  if (want !== 'auto') {
    const p = PROVIDERS.find((x) => x.id === want)
    if (!p) throw new Error(`unknown tunnel "${want}" — use ${PROVIDERS.map((x) => x.id).join(' or ')}`)
    if (!have.includes(p)) throw new Error(`${p.binary} is not installed — ${p.install}`)
    return p
  }
  if (have[0]) return have[0]
  throw new Error(`no tunnel tool found. Install one of:\n${PROVIDERS.map((p) => `  - ${p.binary}: ${p.install}`).join('\n')}`)
}

/** Open the tunnel and wait until it prints its public URL. */
export async function openTunnel(port: number, provider: TunnelProvider, opts: TunnelOptions = {}, deps: TunnelDeps = {}): Promise<Tunnel> {
  const run = deps.spawn ?? spawn
  const child: ChildProcess = run(provider.binary, provider.args(port, opts), { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let last = ''
  let buffer = ''
  let resolveEnded!: (s: string) => void
  const ended = new Promise<string>((r) => (resolveEnded = r))
  let done = false
  const finish = (): void => {
    if (done) return
    done = true
    resolveEnded(scrubAll(last))
  }
  child.on('close', finish)
  child.on('error', (err) => {
    last = err.message
    finish()
  })

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      kill()
      reject(new Error(`${provider.label} did not give a public address in time. Last output: ${scrubAll(last) || '(none)'}`))
    }, deps.timeoutMs ?? 30_000)
    const take = (d: Buffer): void => {
      buffer = (buffer + d.toString('utf8')).slice(-8_000)
      for (const line of d.toString('utf8').split(/\r?\n/)) if (line.trim()) last = line.trim()
      const m = provider.urlPattern.exec(buffer)
      if (m) {
        clearTimeout(timer)
        resolve(m[1]!)
      }
    }
    child.stdout?.on('data', take)
    child.stderr?.on('data', take)
    child.once('close', () => {
      clearTimeout(timer)
      reject(new Error(`${provider.label} stopped before it was ready: ${scrubAll(last) || 'no output'}`))
    })
    child.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`could not start ${provider.binary}: ${err.message}`))
    })
  })

  function kill(): void {
    try {
      child.kill()
    } catch {
      /* already gone */
    }
  }
  return {
    provider: provider.id,
    url,
    host: new URL(url).hostname.toLowerCase(),
    close: async () => {
      kill()
      await Promise.race([ended, new Promise<string>((r) => setTimeout(() => r(''), 2_000))])
    },
    ended,
  }
}
