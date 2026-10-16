import { chunkText, type Button, type ChatBridge } from './chat-bridge.js'
import type { SocketLike } from './discord.js'

/**
 * Slack in Socket Mode: VARA opens an outbound WebSocket with an app-level token, so no public address is needed.
 * Only direct messages to the bot are answered. Slack treats a leading "/" as its own slash command, so in Slack
 * the commands are written with "!" (!new, !stop, !undo, and "pair CODE" to pair).
 */
const API = 'https://slack.com/api'
const LIMIT = 3500

export class SlackApi {
  constructor(
    private readonly botToken: string,
    private readonly appToken: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T extends { ok?: boolean; error?: string }>(method: string, token: string, body: Record<string, unknown> = {}): Promise<T> {
    const res = await this.fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    })
    const json = (await res.json().catch(() => ({}))) as T
    if (!res.ok || !json.ok) throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`) // never the token
    return json
  }

  /** Who the bot token belongs to. */
  async authTest(): Promise<{ user: string; team: string }> {
    return this.call<{ ok?: boolean; error?: string; user: string; team: string }>('auth.test', this.botToken)
  }

  async openSocket(): Promise<string> {
    const r = await this.call<{ ok: boolean; url?: string }>('apps.connections.open', this.appToken)
    if (!r.url) throw new Error('Slack gave no socket address')
    return r.url
  }

  async send(channel: string, text: string, buttons?: Button[]): Promise<void> {
    const parts = chunkText(text, LIMIT)
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      await this.call('chat.postMessage', this.botToken, {
        channel,
        text: parts[i],
        ...(last && buttons?.length
          ? {
              blocks: [
                { type: 'section', text: { type: 'mrkdwn', text: parts[i] } },
                { type: 'actions', elements: buttons.map((b, n) => ({ type: 'button', text: { type: 'plain_text', text: b.label }, action_id: `vara_${n}`, value: b.data, style: n === 0 ? 'primary' : 'danger' })) },
              ],
            }
          : {}),
      })
    }
  }
}

/** One Socket Mode envelope → what the bridge should do (and the acknowledgement Slack requires). Pure. */
export function handleEnvelope(raw: string, bridge: ChatBridge, selfUser: string | undefined): { ack?: string; reconnect?: boolean } {
  let env: { type?: string; envelope_id?: string; payload?: Record<string, unknown> }
  try {
    env = JSON.parse(raw)
  } catch {
    return {}
  }
  const ack = env.envelope_id ? JSON.stringify({ envelope_id: env.envelope_id }) : undefined
  if (env.type === 'disconnect') return { reconnect: true }
  if (env.type === 'events_api') {
    const ev = (env.payload?.['event'] ?? {}) as { type?: string; channel?: string; channel_type?: string; user?: string; text?: string; bot_id?: string; subtype?: string }
    // A person's plain message in a DM with the bot; not edits, joins, or the bot's own words.
    if (ev.type === 'message' && !ev.subtype && !ev.bot_id && ev.user && ev.user !== selfUser && ev.channel) {
      void bridge.handleMessage({ chat: ev.channel, text: ev.text ?? '', private: ev.channel_type === 'im' })
    }
  } else if (env.type === 'interactive' && env.payload?.['type'] === 'block_actions') {
    const action = (env.payload['actions'] as Array<{ value?: string }> | undefined)?.[0]
    const channel = (env.payload['channel'] as { id?: string } | undefined)?.id
    if (action?.value && channel) void bridge.handleTap({ id: channel, chat: channel, data: action.value })
  }
  return ack ? { ack } : {}
}

/** Keeps the Socket Mode connection alive and reconnects when Slack asks or the line drops. */
export class SlackSocket {
  private socket: SocketLike | null = null
  private stopped = false
  private selfUser: string | undefined

  constructor(
    private readonly api: SlackApi,
    private readonly bridge: ChatBridge,
    private readonly log: (l: string) => void,
    private readonly connect: (url: string) => SocketLike = (url) => new (globalThis as unknown as { WebSocket: new (u: string) => SocketLike }).WebSocket(url),
  ) {}

  start(): () => void {
    void this.run(0)
    return () => {
      this.stopped = true
      try {
        this.socket?.close()
      } catch {
        /* already closed */
      }
    }
  }

  private async run(attempt: number): Promise<void> {
    if (this.stopped) return
    try {
      this.selfUser ??= (await this.api.authTest().catch(() => ({ user: '' }))).user
      const ws = this.connect(await this.api.openSocket())
      this.socket = ws
      ws.onmessage = (e) => {
        const r = handleEnvelope(String(e.data), this.bridge, undefined)
        if (r.ack) ws.send(r.ack)
        if (r.reconnect) ws.close()
      }
      ws.onclose = () => this.retry(attempt)
      ws.onerror = () => {}
    } catch (err) {
      this.log(`Slack: ${(err as Error).message}`)
      this.retry(attempt)
    }
  }

  private retry(attempt: number): void {
    if (this.stopped) return
    const wait = Math.min(30_000, 2000 * (attempt + 1))
    setTimeout(() => void this.run(attempt + 1), wait)
  }
}
