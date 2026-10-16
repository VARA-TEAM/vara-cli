import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { VARA_HOME } from '../config/paths.js'

/**
 * The part of a messaging gateway that does not depend on the platform. A platform adapter (Telegram, Discord,
 * Slack…) turns what it receives into `Incoming` / `Tap` and gives the bridge a `Platform` to answer with; the rules
 * are the same everywhere:
 *
 *   - ONE person is served: the owner, who pairs a private chat once with a code that VARA prints (ten minutes, used
 *     once, five wrong tries lock pairing for an hour). Everybody else — and every group channel — is ignored with no
 *     reply at all, so the bot does not even confirm that it exists.
 *   - The agent's answer is sent when its turn ends; anything risky arrives as Approve / Reject buttons.
 */

export interface AgentEvents {
  onText(delta: string): void
  onState(state: string, reason?: string): void
  onApproval(req: { id: string; title: string; detail: string }): void
  onCompleted(summary: string): void
}

/** What the bridge needs from the host, so it can be tested without one. */
export interface AgentPort {
  create(message: string): Promise<string>
  send(sessionId: string, text: string): Promise<void>
  pause(sessionId: string): Promise<void>
  undo(sessionId: string): Promise<string>
  resolveApproval(sessionId: string, approvalId: string, approved: boolean): Promise<void>
  /** Listen to a session until the returned function is called. */
  watch(sessionId: string, events: AgentEvents): Promise<() => void>
}

export interface Button {
  label: string
  data: string
}

/** How the bridge talks back. */
export interface Platform {
  send(chat: string, text: string, buttons?: Button[]): Promise<void>
  /** Confirm a button tap (Telegram wants an answer, Discord an interaction response). */
  ack(tap: string, text?: string): Promise<void>
}

export interface Incoming {
  chat: string
  text: string
  /** A one-to-one chat. Anything else is ignored. */
  private: boolean
}

export interface Tap {
  /** Platform's id for this tap (used by `ack`). */
  id: string
  chat: string
  data: string
}

interface State {
  chat?: string
  /** Before v0.5.7 Telegram stored a number here. */
  chatId?: number | string
  sessionId?: string
  pairing?: { code: string; expiresAt: number }
  failures?: { count: number; since: number }
}

export const gatewayFile = (id: string): string => join(VARA_HOME, 'gateway', `${id}.json`)
const PAIR_MINUTES = 10
const MAX_BAD_CODES = 5

async function load(file: string): Promise<State> {
  try {
    const s = JSON.parse(await readFile(file, 'utf8')) as State
    if (s.chat === undefined && s.chatId !== undefined) s.chat = String(s.chatId)
    delete s.chatId
    return s
  } catch {
    return {}
  }
}
async function save(file: string, s: State): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(s), { encoding: 'utf8', mode: 0o600 })
}

/** A fresh one-time pairing code. */
export async function startPairing(file: string, now: () => number = Date.now): Promise<{ code: string; minutes: number }> {
  const s = await load(file)
  const code = randomBytes(5).toString('hex').toUpperCase().slice(0, 8)
  s.pairing = { code, expiresAt: now() + PAIR_MINUTES * 60_000 }
  delete s.failures
  await save(file, s)
  return { code, minutes: PAIR_MINUTES }
}

export async function unpair(file: string): Promise<void> {
  await save(file, {})
}

/** Whether a chat is paired and whether a pairing code is waiting — for the settings screens. */
export async function pairingStatus(file: string, now: () => number = Date.now): Promise<{ paired: boolean; code?: string; expiresAt?: number }> {
  const s = await load(file)
  const waiting = s.pairing && s.pairing.expiresAt > now() ? { code: s.pairing.code, expiresAt: s.pairing.expiresAt } : {}
  return { paired: s.chat !== undefined, ...(s.chat === undefined ? waiting : {}) }
}

export class ChatBridge {
  private stopWatching: (() => void) | null = null
  private watching: string | null = null
  private buffer = ''

  constructor(
    private readonly out: Platform,
    private readonly agent: AgentPort,
    private readonly file: string,
    private readonly now: () => number = Date.now,
  ) {}

  close(): void {
    this.stopWatching?.()
    this.stopWatching = null
    this.watching = null
  }

  /** One message. Never throws: a bad one must not stop the loop. */
  async handleMessage(m: Incoming): Promise<void> {
    try {
      if (!m.private) return
      await this.onMessage(m.chat, m.text.trim())
    } catch {
      /* the next message is handled normally */
    }
  }

  async handleTap(t: Tap): Promise<void> {
    try {
      const state = await load(this.file)
      // Only the paired chat can answer an approval.
      if (state.chat === undefined || state.chat !== t.chat) return
      const m = /^a:([\w-]+):([\w-]+):([01])$/.exec(t.data)
      if (!m || m[1] !== state.sessionId) return void (await this.out.ack(t.id, 'That request is no longer current.'))
      await this.agent.resolveApproval(m[1]!, m[2]!, m[3] === '1')
      await this.out.ack(t.id, m[3] === '1' ? 'Approved' : 'Rejected')
    } catch {
      /* ignore */
    }
  }

  private async onMessage(chat: string, text: string): Promise<void> {
    const state = await load(this.file)
    if (state.chat !== chat) return this.tryPair(state, chat, text)
    if (!text) return
    // Commands may start with / or ! (Slack swallows a leading slash).
    const [first = ''] = text.split(/\s+/)
    const cmd = /^[/!]\w+/.test(first) ? first.slice(1).toLowerCase().replace(/@\w+$/, '') : ''
    switch (cmd) {
      case 'start':
      case 'help':
        return this.out.send(chat, 'Write what you want done and VARA works on it. /new starts a fresh session · /stop pauses the agent · /undo puts back its last file change · /unpair disconnects this chat. (On Slack write ! instead of /.)')
      case 'new':
        this.close()
        delete state.sessionId
        await save(this.file, state)
        return this.out.send(chat, 'New session: your next message starts it.')
      case 'stop':
        if (state.sessionId) await this.agent.pause(state.sessionId)
        return this.out.send(chat, 'Paused. Send a message to continue.')
      case 'undo':
        if (!state.sessionId) return this.out.send(chat, 'No session yet.')
        return this.out.send(chat, await this.agent.undo(state.sessionId))
      case 'unpair':
        this.close()
        await unpair(this.file)
        return this.out.send(chat, 'Disconnected. Pair again from VARA (Settings → Gateways, or vara gateway <platform> pair).')
      default:
        return this.relay(state, chat, text)
    }
  }

  private async tryPair(state: State, chat: string, text: string): Promise<void> {
    const m = /^[/!]?pair\s+([A-Za-z0-9]{4,16})$/i.exec(text)
    if (!m) return // strangers get no answer at all
    const bad = state.failures && this.now() - state.failures.since < 3_600_000 ? state.failures.count : 0
    if (bad >= MAX_BAD_CODES) return
    const p = state.pairing
    if (p && p.expiresAt > this.now() && p.code === m[1]!.toUpperCase()) {
      await save(this.file, { chat })
      return this.out.send(chat, 'Paired. This chat now controls VARA on your machine. Write what you want done; /help lists the commands.')
    }
    await save(this.file, { ...state, failures: { count: bad + 1, since: state.failures?.since ?? this.now() } })
  }

  private async relay(state: State, chat: string, text: string): Promise<void> {
    let id = state.sessionId
    this.buffer = ''
    if (!id) {
      id = await this.agent.create(text)
      state.sessionId = id
      await save(this.file, state)
      await this.watch(id, chat)
    } else {
      await this.watch(id, chat)
      await this.agent.send(id, text)
    }
  }

  private async watch(id: string, chat: string): Promise<void> {
    if (this.watching === id) return
    this.close()
    this.watching = id
    this.stopWatching = await this.agent.watch(id, {
      onText: (d) => void (this.buffer += d),
      onState: (state, reason) => {
        if (['ready', 'idle', 'failed', 'paused', 'stopped', 'interrupted'].includes(state)) void this.flush(chat, state === 'ready' || state === 'idle' ? '' : `[${state}${reason ? `: ${reason}` : ''}]`)
      },
      onApproval: (req) =>
        void this.out.send(chat, `VARA asks permission: ${req.title}\n\n${req.detail.slice(0, 1500)}`, [
          { label: 'Approve', data: `a:${id}:${req.id}:1` },
          { label: 'Reject', data: `a:${id}:${req.id}:0` },
        ]),
      onCompleted: (summary) => {
        this.buffer = ''
        void this.out.send(chat, `Done: ${summary}`)
      },
    })
  }

  private async flush(chat: string, suffix: string): Promise<void> {
    const text = this.buffer.trim()
    this.buffer = ''
    const out = [text, suffix].filter(Boolean).join('\n')
    if (out) await this.out.send(chat, out).catch(() => {})
  }
}

/** Split a long answer at line breaks so each piece fits in one message of a platform with this limit. */
export function chunkText(text: string, limit: number): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out.length ? out : ['(empty)']
}
