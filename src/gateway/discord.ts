import { chunkText, type Button, type ChatBridge } from './chat-bridge.js'

/**
 * Discord, in direct messages only. Receiving uses Discord's WebSocket gateway (an outbound connection: nothing is
 * opened on your machine); sending and button taps use the REST API. Group channels are ignored by the bridge.
 */
const API = 'https://discord.com/api/v10'
const GATEWAY = 'wss://gateway.discord.gg/?v=10&encoding=json'
/** DIRECT_MESSAGES only: message text in a DM needs no privileged intent. */
const INTENTS = 1 << 12
const LIMIT = 1900

export interface SocketLike {
  send(data: string): void
  close(): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e?: unknown) => void) | null
  onerror: ((e?: unknown) => void) | null
}

export class DiscordApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bot ${this.token}` } : {}), 'user-agent': 'VARA (https://github.com/VARA-TEAM/vara-cli)' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    })
    if (!res.ok) throw new Error(`Discord ${path.split('/')[1] ?? ''} failed (${res.status})`) // the token is never in the message
    return (res.status === 204 ? undefined : await res.json().catch(() => undefined)) as T
  }

  async me(): Promise<{ id: string; username: string }> {
    return this.call('GET', '/users/@me')
  }

  async send(channel: string, text: string, buttons?: Button[]): Promise<void> {
    const parts = chunkText(text, LIMIT)
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      await this.call('POST', `/channels/${channel}/messages`, {
        content: parts[i],
        ...(last && buttons?.length ? { components: [{ type: 1, components: buttons.map((b, n) => ({ type: 2, style: n === 0 ? 3 : 4, label: b.label, custom_id: b.data })) }] } : {}),
      })
    }
  }

  /** Answer a button tap with a message only the tapper sees. */
  async answerTap(tap: string, text: string): Promise<void> {
    const [id, token] = tap.split('/')
    await this.call('POST', `/interactions/${id}/${token}/callback`, { type: 4, data: { content: text, flags: 64 } }, false)
  }
}

/** One decoded frame of Discord's gateway protocol → what the bridge should do. Pure, so it is testable. */
export function handleDispatch(t: string, d: Record<string, unknown>, bridge: ChatBridge, selfId: string | undefined): void {
  if (t === 'READY') return
  if (t === 'MESSAGE_CREATE') {
    const author = d['author'] as { id?: string; bot?: boolean } | undefined
    if (!author || author.bot || author.id === selfId) return
    void bridge.handleMessage({ chat: String(d['channel_id']), text: String(d['content'] ?? ''), private: d['guild_id'] === undefined })
  } else if (t === 'INTERACTION_CREATE' && d['type'] === 3) {
    const data = d['data'] as { custom_id?: string } | undefined
    void bridge.handleTap({ id: `${d['id']}/${d['token']}`, chat: String(d['channel_id']), data: data?.custom_id ?? '' })
  }
}

/** Keeps one gateway connection alive: hello → identify → heartbeats → dispatches; reconnects when it drops. */
export class DiscordGateway {
  private socket: SocketLike | null = null
  private seq: number | null = null
  private beat: ReturnType<typeof setInterval> | null = null
  private stopped = false
  private selfId: string | undefined

  constructor(
    private readonly token: string,
    private readonly bridge: ChatBridge,
    private readonly log: (l: string) => void,
    private readonly connect: (url: string) => SocketLike = (url) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url),
  ) {}

  start(): () => void {
    void this.run(0)
    return () => {
      this.stopped = true
      this.teardown()
    }
  }

  private async run(attempt: number): Promise<void> {
    if (this.stopped) return
    const ws = this.connect(GATEWAY)
    this.socket = ws
    ws.onmessage = (e) => this.frame(String(e.data), ws)
    ws.onclose = () => {
      this.teardown()
      if (this.stopped) return
      const wait = Math.min(30_000, 2000 * (attempt + 1))
      this.log(`Discord: connection closed, retrying in ${Math.round(wait / 1000)}s`)
      setTimeout(() => void this.run(attempt + 1), wait)
    }
    ws.onerror = () => {}
  }

  /** Exposed for tests: handle one raw frame from the server. */
  frame(raw: string, ws: SocketLike = this.socket!): void {
    let m: { op: number; t?: string; s?: number | null; d?: unknown }
    try {
      m = JSON.parse(raw)
    } catch {
      return
    }
    if (typeof m.s === 'number') this.seq = m.s
    switch (m.op) {
      case 10: {
        const every = Number((m.d as { heartbeat_interval?: number }).heartbeat_interval) || 41_250
        this.beat = setInterval(() => ws.send(JSON.stringify({ op: 1, d: this.seq })), every)
        ws.send(JSON.stringify({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'vara', device: 'vara' } } }))
        return
      }
      case 1:
        ws.send(JSON.stringify({ op: 1, d: this.seq }))
        return
      case 7: // the server asks us to reconnect
      case 9: // session is no longer valid
        ws.close()
        return
      case 0: {
        const d = (m.d ?? {}) as Record<string, unknown>
        if (m.t === 'READY') this.selfId = (d['user'] as { id?: string } | undefined)?.id
        handleDispatch(m.t ?? '', d, this.bridge, this.selfId)
        return
      }
    }
  }

  private teardown(): void {
    if (this.beat) clearInterval(this.beat)
    this.beat = null
    try {
      this.socket?.close()
    } catch {
      /* already closed */
    }
    this.socket = null
  }
}
