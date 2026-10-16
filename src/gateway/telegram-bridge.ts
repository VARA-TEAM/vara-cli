import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { VARA_HOME } from '../config/paths.js'
import type { TgButton, TgUpdate } from './telegram-api.js'

/**
 * Talk to VARA from Telegram. The bot only ever answers ONE person: the owner, who pairs it once with a code that
 * `vara gateway telegram pair` prints (valid for ten minutes, usable once). Anyone else is ignored without a reply,
 * so the bot does not even confirm that it exists. It works by polling (no open port), only in private chats, and
 * approvals the agent asks for arrive as Approve / Reject buttons — nothing risky is done without that tap.
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

export interface Messenger {
  sendMessage(chatId: number, text: string, buttons?: TgButton[]): Promise<void>
  answerCallback(id: string, text?: string): Promise<void>
}

interface State {
  chatId?: number
  sessionId?: string
  pairing?: { code: string; expiresAt: number }
  failures?: { count: number; since: number }
}

export const statePath = (): string => join(VARA_HOME, 'gateway', 'telegram.json')
const PAIR_MINUTES = 10
const MAX_BAD_CODES = 5

async function load(file: string): Promise<State> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as State
  } catch {
    return {}
  }
}
async function save(file: string, s: State): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(s), { encoding: 'utf8', mode: 0o600 })
}

/** Called by `vara gateway telegram pair`: a fresh one-time code. */
export async function startPairing(file = statePath(), now: () => number = Date.now): Promise<{ code: string; minutes: number }> {
  const s = await load(file)
  const code = randomBytes(5).toString('hex').toUpperCase().slice(0, 8)
  s.pairing = { code, expiresAt: now() + PAIR_MINUTES * 60_000 }
  delete s.failures
  await save(file, s)
  return { code, minutes: PAIR_MINUTES }
}

/** Whether a chat is paired and whether a pairing code is waiting — for the settings screens. */
export async function pairingStatus(file = statePath(), now: () => number = Date.now): Promise<{ paired: boolean; code?: string; expiresAt?: number }> {
  const s = await load(file)
  const waiting = s.pairing && s.pairing.expiresAt > now() ? { code: s.pairing.code, expiresAt: s.pairing.expiresAt } : {}
  return { paired: s.chatId !== undefined, ...(s.chatId === undefined ? waiting : {}) }
}

export async function unpair(file = statePath()): Promise<void> {
  await save(file, {})
}

export class TelegramBridge {
  private stopWatching: (() => void) | null = null
  private watching: string | null = null
  private buffer = ''
  private chat: number | null = null

  constructor(
    private readonly tg: Messenger,
    private readonly agent: AgentPort,
    private readonly file = statePath(),
    private readonly now: () => number = Date.now,
  ) {}

  close(): void {
    this.stopWatching?.()
    this.stopWatching = null
    this.watching = null
  }

  /** One Telegram update. Never throws: a bad update must not stop the loop. */
  async handle(u: TgUpdate): Promise<void> {
    try {
      if (u.callback_query) return await this.onCallback(u.callback_query)
      const m = u.message
      if (!m || m.chat.type !== 'private') return
      await this.onMessage(m.chat.id, (m.text ?? '').trim())
    } catch {
      /* the next update is handled normally */
    }
  }

  private async onMessage(chatId: number, text: string): Promise<void> {
    const state = await load(this.file)
    if (state.chatId !== chatId) return this.tryPair(state, chatId, text)
    if (!text) return
    this.chat = chatId
    const [cmd = '', ...rest] = text.split(/\s+/)
    switch (cmd.toLowerCase().replace(/@\w+$/, '')) {
      case '/start':
      case '/help':
        return this.tg.sendMessage(chatId, 'Write what you want done and VARA works on it. /new starts a fresh session · /stop pauses the agent · /undo puts back its last file change · /unpair disconnects this chat.')
      case '/new':
        this.close()
        delete state.sessionId
        await save(this.file, state)
        return this.tg.sendMessage(chatId, 'New session: your next message starts it.')
      case '/stop':
        if (state.sessionId) await this.agent.pause(state.sessionId)
        return this.tg.sendMessage(chatId, 'Paused. Send a message to continue.')
      case '/undo': {
        if (!state.sessionId) return this.tg.sendMessage(chatId, 'No session yet.')
        return this.tg.sendMessage(chatId, await this.agent.undo(state.sessionId))
      }
      case '/unpair':
        this.close()
        await unpair(this.file)
        return this.tg.sendMessage(chatId, 'Disconnected. Pair again with `vara gateway telegram pair`.')
      default:
        void rest
        return this.relay(state, chatId, text)
    }
  }

  private async tryPair(state: State, chatId: number, text: string): Promise<void> {
    const m = /^\/pair\s+([A-Za-z0-9]{4,16})$/.exec(text)
    if (!m) return // strangers get no answer at all
    const bad = state.failures && this.now() - state.failures.since < 3_600_000 ? state.failures.count : 0
    if (bad >= MAX_BAD_CODES) return
    const p = state.pairing
    if (p && p.expiresAt > this.now() && p.code === m[1]!.toUpperCase()) {
      await save(this.file, { chatId })
      return this.tg.sendMessage(chatId, 'Paired. This chat now controls VARA on your machine. Write what you want done; /help lists the commands.')
    }
    await save(this.file, { ...state, failures: { count: bad + 1, since: state.failures?.since ?? this.now() } })
  }

  private async relay(state: State, chatId: number, text: string): Promise<void> {
    let id = state.sessionId
    this.buffer = ''
    if (!id) {
      id = await this.agent.create(text)
      state.sessionId = id
      await save(this.file, state)
      await this.watch(id, chatId)
    } else {
      await this.watch(id, chatId)
      await this.agent.send(id, text)
    }
  }

  private async watch(id: string, chatId: number): Promise<void> {
    if (this.watching === id) return
    this.close()
    this.watching = id
    this.stopWatching = await this.agent.watch(id, {
      onText: (d) => void (this.buffer += d),
      onState: (state, reason) => {
        // The turn is over: show what the agent said. Approvals and completion have their own messages.
        if (['ready', 'idle', 'failed', 'paused', 'stopped', 'interrupted'].includes(state)) void this.flush(chatId, state === 'ready' || state === 'idle' ? '' : `[${state}${reason ? `: ${reason}` : ''}]`)
      },
      onApproval: (req) =>
        void this.tg.sendMessage(chatId, `VARA asks permission: ${req.title}\n\n${req.detail.slice(0, 1500)}`, [
          { text: 'Approve', callback_data: `a:${id}:${req.id}:1` },
          { text: 'Reject', callback_data: `a:${id}:${req.id}:0` },
        ]),
      onCompleted: (summary) => {
        this.buffer = ''
        void this.tg.sendMessage(chatId, `Done: ${summary}`)
      },
    })
  }

  private async flush(chatId: number, suffix: string): Promise<void> {
    const text = this.buffer.trim()
    this.buffer = ''
    const out = [text, suffix].filter(Boolean).join('\n')
    if (out) await this.tg.sendMessage(chatId, out).catch(() => {})
  }

  private async onCallback(q: NonNullable<TgUpdate['callback_query']>): Promise<void> {
    const state = await load(this.file)
    const chatId = q.message?.chat.id
    // Only the paired chat can answer an approval.
    if (!chatId || state.chatId !== chatId) return
    const m = /^a:([\w-]+):([\w-]+):([01])$/.exec(q.data ?? '')
    if (!m || m[1] !== state.sessionId) return void (await this.tg.answerCallback(q.id, 'That request is no longer current.'))
    await this.agent.resolveApproval(m[1]!, m[2]!, m[3] === '1')
    await this.tg.answerCallback(q.id, m[3] === '1' ? 'Approved' : 'Rejected')
  }
}
