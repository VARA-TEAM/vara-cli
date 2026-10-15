import { openTunnel, pickProvider, type Tunnel, type TunnelDeps } from './tunnel.js'

/**
 * The life cycle of a public share link: open the tunnel, make the server
 * accept (and treat as public) the tunnel's host name, hand guests the public
 * address, and undo all of it when the time is up, the tunnel dies, or the
 * host closes. Nothing here outlives the host process.
 */

export interface ShareInfo {
  url: string
  host: string
  provider: string
  expiresAt?: string
}

export interface ShareWiring {
  /** The local server's port the tunnel exposes. */
  port: number
  /** Live arrays read by the server per request. */
  allowedHosts: string[]
  publicHosts: string[]
  /** Address guests should be given (undefined = fall back to what it was before sharing). */
  setGuestBase(url: string | undefined): void
  /** Called once when sharing ends for any reason other than stop() being called by the owner. */
  onEnd?(reason: string): void
  deps?: TunnelDeps
  now?: () => number
}

export const DEFAULT_SHARE_MINUTES = 120

export class Sharing {
  private tunnel: Tunnel | null = null
  private info: ShareInfo | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly w: ShareWiring) {}

  current(): ShareInfo | undefined {
    return this.info ?? undefined
  }

  /** Open the tunnel. `minutes` = 0 keeps it open until the host closes. */
  async start(want: string, opts: { minutes?: number; sshHost?: string } = {}): Promise<ShareInfo> {
    if (this.tunnel) throw new Error('a public link is already open')
    const provider = await pickProvider(want, this.w.deps)
    const tunnel = await openTunnel(this.w.port, provider, opts.sshHost ? { sshHost: opts.sshHost } : {}, this.w.deps)
    const minutes = opts.minutes ?? DEFAULT_SHARE_MINUTES
    const now = this.w.now ?? Date.now
    this.tunnel = tunnel
    this.info = { url: tunnel.url, host: tunnel.host, provider: tunnel.provider, ...(minutes > 0 ? { expiresAt: new Date(now() + minutes * 60_000).toISOString() } : {}) }
    this.w.allowedHosts.push(tunnel.host)
    this.w.publicHosts.push(tunnel.host)
    this.w.setGuestBase(tunnel.url)
    if (minutes > 0) {
      this.timer = setTimeout(() => void this.end(`the ${minutes}-minute public link expired`), minutes * 60_000)
      this.timer.unref()
    }
    void tunnel.ended.then((last) => {
      if (this.tunnel === tunnel) void this.end(`the tunnel closed${last ? `: ${last}` : ''}`)
    })
    return this.info
  }

  /** Close the link because the owner (or the host shutting down) asked. */
  async stop(): Promise<void> {
    await this.teardown()
  }

  private async end(reason: string): Promise<void> {
    if (!this.tunnel) return
    await this.teardown()
    this.w.onEnd?.(reason)
  }

  private async teardown(): Promise<void> {
    const t = this.tunnel
    if (!t) return
    this.tunnel = null
    this.info = null
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const list of [this.w.allowedHosts, this.w.publicHosts]) {
      const i = list.indexOf(t.host)
      if (i >= 0) list.splice(i, 1)
    }
    this.w.setGuestBase(undefined)
    await t.close()
  }
}
