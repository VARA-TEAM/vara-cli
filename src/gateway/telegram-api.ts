/** The few Telegram Bot API calls the bridge needs. No dependency: plain fetch, so tests can inject a fake server. */
export interface TgUpdate {
  update_id: number
  message?: { message_id: number; text?: string; chat: { id: number; type: string }; from?: { id: number } }
  callback_query?: { id: string; data?: string; from: { id: number }; message?: { chat: { id: number }; message_id: number } }
}

export interface TgButton {
  text: string
  callback_data: string
}

const LIMIT = 3800

/** Split a long answer at line breaks so each piece fits in one Telegram message. */
export function chunk(text: string, limit = LIMIT): string[] {
  const out: string[] = []
  let rest = text.trim()
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit)
    if (cut < limit / 2) cut = limit
    out.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) out.push(rest)
  return out
}

export class TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly base = 'https://api.telegram.org',
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      ...(signal ? { signal } : {}),
    })
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string }
    // The token is part of the URL: never let it into an error message.
    if (!res.ok || !json.ok) throw new Error(`Telegram ${method} failed: ${json.description ?? res.status}`)
    return json.result as T
  }

  /** Who the token belongs to (also proves the token works). */
  getMe(): Promise<{ id: number; username?: string; first_name?: string }> {
    return this.call('getMe', {})
  }

  getUpdates(offset: number, timeoutSec: number, signal?: AbortSignal): Promise<TgUpdate[]> {
    return this.call<TgUpdate[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message', 'callback_query'] }, signal)
  }

  async sendMessage(chatId: number, text: string, buttons?: TgButton[]): Promise<void> {
    const parts = chunk(text || '(empty)')
    for (let i = 0; i < parts.length; i++) {
      const last = i === parts.length - 1
      await this.call('sendMessage', {
        chat_id: chatId,
        text: parts[i],
        disable_web_page_preview: true,
        ...(last && buttons?.length ? { reply_markup: { inline_keyboard: [buttons] } } : {}),
      })
    }
  }

  async answerCallback(id: string, text?: string): Promise<void> {
    await this.call('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}) })
  }

  async sendTyping(chatId: number): Promise<void> {
    await this.call('sendChatAction', { chat_id: chatId, action: 'typing' }).catch(() => {})
  }
}
