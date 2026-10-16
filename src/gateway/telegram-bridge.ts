import { ChatBridge, gatewayFile, type AgentPort, type Platform } from './chat-bridge.js'
import type { TgButton, TgUpdate } from './telegram-api.js'

export { startPairing, unpair, pairingStatus, type AgentEvents, type AgentPort } from './chat-bridge.js'

/** The Telegram side: update objects in, the generic bridge doing the work, Telegram calls out. */
export interface Messenger {
  sendMessage(chatId: number, text: string, buttons?: TgButton[]): Promise<void>
  answerCallback(id: string, text?: string): Promise<void>
}

export const statePath = (): string => gatewayFile('telegram')

export class TelegramBridge {
  private readonly bridge: ChatBridge

  constructor(tg: Messenger, agent: AgentPort, file = statePath(), now: () => number = Date.now) {
    const out: Platform = {
      send: (chat, text, buttons) => tg.sendMessage(Number(chat), text, buttons?.map((b) => ({ text: b.label, callback_data: b.data }))),
      ack: (tap, text) => tg.answerCallback(tap, text),
    }
    this.bridge = new ChatBridge(out, agent, file, now)
  }

  close(): void {
    this.bridge.close()
  }

  /** One Telegram update. Never throws. */
  async handle(u: TgUpdate): Promise<void> {
    const q = u.callback_query
    if (q) {
      const chat = q.message?.chat.id
      if (chat !== undefined) await this.bridge.handleTap({ id: q.id, chat: String(chat), data: q.data ?? '' })
      return
    }
    const m = u.message
    if (!m) return
    await this.bridge.handleMessage({ chat: String(m.chat.id), text: m.text ?? '', private: m.chat.type === 'private' })
  }
}
