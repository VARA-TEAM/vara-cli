import { ChatBridge, type AgentPort, type Platform } from './chat-bridge.js'
import { DiscordApi, DiscordGateway } from './discord.js'
import { SlackApi, SlackSocket } from './slack.js'
import { TelegramApi } from './telegram-api.js'
import { TelegramBridge } from './telegram-bridge.js'

/** Text in both languages: the settings screens show the one the person reads. */
export interface L {
  en: string
  ar: string
}

export interface GatewaySecret {
  /** Name in the vault (and the environment). */
  name: string
  label: L
  help: L
  /** What a real value looks like: a quick check before anything is sent anywhere. */
  pattern: RegExp
}

export interface Runtime {
  secrets: Record<string, string>
  agent: AgentPort
  file: string
  log: (line: string) => void
  fetchImpl?: typeof fetch
}

/**
 * One messaging platform. To add another: describe its secrets and setup steps here, say how to check them and how to
 * start listening; the pairing, the commands, the approvals and every settings screen come from the shared bridge.
 */
export interface GatewayProvider {
  id: 'telegram' | 'discord' | 'slack'
  name: string
  intro: L
  steps: L[]
  secrets: GatewaySecret[]
  /** Prove the secrets work; returns the bot's name. Throws a readable message when they do not. */
  verify(secrets: Record<string, string>, fetchImpl?: typeof fetch): Promise<string>
  /** Start listening; returns what stops it. */
  start(rt: Runtime): () => void
}

const need = (s: Record<string, string>, k: string): string => s[k] ?? ''

const telegram: GatewayProvider = {
  id: 'telegram',
  name: 'Telegram',
  intro: { en: 'Talk to VARA from Telegram: a private chat with your own bot.', ar: 'تكلّم مع VARA من Telegram: محادثة خاصة مع بوتك أنت.' },
  steps: [
    { en: 'In Telegram open @BotFather, send /newbot and follow it.', ar: 'في Telegram افتح @BotFather وأرسل /newbot واتبع الخطوات.' },
    { en: 'Copy the token it gives you (like 123456789:AA…) and paste it below.', ar: 'انسخ التوكن الذي يعطيك (مثل 123456789:AA…) والصقه أدناه.' },
    { en: 'Then make a pairing code and send /pair CODE to your bot.', ar: 'ثم أنشئ رمز الربط وأرسل /pair الرمز إلى بوتك.' },
  ],
  secrets: [{ name: 'TELEGRAM_BOT_TOKEN', label: { en: 'Bot token', ar: 'توكن البوت' }, help: { en: 'From @BotFather.', ar: 'من @BotFather.' }, pattern: /^\d{5,}:[\w-]{20,}$/ }],
  async verify(secrets, fetchImpl) {
    const me = await new TelegramApi(need(secrets, 'TELEGRAM_BOT_TOKEN'), fetchImpl).getMe()
    return me.username ? `@${me.username}` : (me.first_name ?? 'your bot')
  },
  start(rt) {
    const api = new TelegramApi(need(rt.secrets, 'TELEGRAM_BOT_TOKEN'), rt.fetchImpl)
    const bridge = new TelegramBridge(api, rt.agent, rt.file)
    const abort = new AbortController()
    let offset = 0
    void (async () => {
      while (!abort.signal.aborted) {
        try {
          for (const u of await api.getUpdates(offset, 25, abort.signal)) {
            offset = Math.max(offset, u.update_id + 1)
            await bridge.handle(u)
          }
        } catch (err) {
          if (abort.signal.aborted) break
          rt.log(`Telegram: ${(err as Error).message} (retrying)`)
          await new Promise((r) => setTimeout(r, 3000))
        }
      }
    })()
    return () => {
      abort.abort()
      bridge.close()
    }
  },
}

const discord: GatewayProvider = {
  id: 'discord',
  name: 'Discord',
  intro: { en: 'Talk to VARA in a direct message with your own Discord bot.', ar: 'تكلّم مع VARA في رسالة خاصة مع بوت Discord خاص بك.' },
  steps: [
    { en: 'At discord.com/developers/applications make an application, add a Bot, and copy its token (Reset Token).', ar: 'في discord.com/developers/applications أنشئ تطبيقاً وأضف Bot وانسخ توكنه (Reset Token).' },
    { en: 'Invite the bot to a server you are in (OAuth2 → URL Generator → scope "bot"), so you can open a direct message with it.', ar: 'ادعُ البوت إلى خادم أنت فيه (OAuth2 ← URL Generator ← نطاق "bot") لتفتح معه رسالة خاصة.' },
    { en: 'Paste the token below, make a pairing code, and send "pair CODE" to the bot in a direct message.', ar: 'الصق التوكن أدناه وأنشئ رمز الربط وأرسل "pair الرمز" إلى البوت في رسالة خاصة.' },
  ],
  secrets: [{ name: 'DISCORD_BOT_TOKEN', label: { en: 'Bot token', ar: 'توكن البوت' }, help: { en: 'Bot → Reset Token.', ar: 'Bot ← Reset Token.' }, pattern: /^[\w.-]{50,120}$/ }],
  async verify(secrets, fetchImpl) {
    return `${(await new DiscordApi(need(secrets, 'DISCORD_BOT_TOKEN'), fetchImpl).me()).username}`
  },
  start(rt) {
    const api = new DiscordApi(need(rt.secrets, 'DISCORD_BOT_TOKEN'), rt.fetchImpl)
    const out: Platform = { send: (c, t, b) => api.send(c, t, b), ack: (tap, t) => api.answerTap(tap, t ?? 'Done').catch(() => {}) }
    const bridge = new ChatBridge(out, rt.agent, rt.file)
    const stop = new DiscordGateway(need(rt.secrets, 'DISCORD_BOT_TOKEN'), bridge, rt.log).start()
    return () => {
      stop()
      bridge.close()
    }
  },
}

const slack: GatewayProvider = {
  id: 'slack',
  name: 'Slack',
  intro: { en: 'Talk to VARA in a Slack direct message (Socket Mode: no public address needed). In Slack write ! instead of / (!new, !stop, !undo).', ar: 'تكلّم مع VARA في رسالة خاصة على Slack (Socket Mode: بلا عنوان عام). في Slack اكتب ! بدل / (‎!new و!stop و!undo).' },
  steps: [
    { en: 'At api.slack.com/apps create an app, turn on Socket Mode, and make an App-Level Token with the connections:write scope (xapp-…).', ar: 'في api.slack.com/apps أنشئ تطبيقاً وفعّل Socket Mode وأنشئ App-Level Token بنطاق connections:write (‎xapp-…).' },
    { en: 'Under Event Subscriptions subscribe the bot to message.im; under OAuth give it chat:write and im:history; install it and copy the Bot Token (xoxb-…).', ar: 'من Event Subscriptions اشترك بـmessage.im، ومن OAuth امنحه chat:write وim:history ثم ثبّته وانسخ Bot Token (‎xoxb-…).' },
    { en: 'Paste both tokens, make a pairing code, and send "pair CODE" to the bot in a direct message.', ar: 'الصق التوكنين وأنشئ رمز الربط وأرسل "pair الرمز" إلى البوت في رسالة خاصة.' },
  ],
  secrets: [
    { name: 'SLACK_BOT_TOKEN', label: { en: 'Bot token (xoxb-…)', ar: 'توكن البوت (‎xoxb-…)' }, help: { en: 'OAuth & Permissions.', ar: 'OAuth & Permissions.' }, pattern: /^xoxb-[\w-]{20,}$/ },
    { name: 'SLACK_APP_TOKEN', label: { en: 'App-level token (xapp-…)', ar: 'توكن التطبيق (‎xapp-…)' }, help: { en: 'Basic Information → App-Level Tokens.', ar: 'Basic Information ← App-Level Tokens.' }, pattern: /^xapp-[\w-]{20,}$/ },
  ],
  async verify(secrets, fetchImpl) {
    const r = await new SlackApi(need(secrets, 'SLACK_BOT_TOKEN'), need(secrets, 'SLACK_APP_TOKEN'), fetchImpl).authTest()
    return `${r.user} (${r.team})`
  },
  start(rt) {
    const api = new SlackApi(need(rt.secrets, 'SLACK_BOT_TOKEN'), need(rt.secrets, 'SLACK_APP_TOKEN'), rt.fetchImpl)
    const out: Platform = { send: (c, t, b) => api.send(c, t, b), ack: (tap, t) => (t ? api.send(tap, t).catch(() => {}) : Promise.resolve()) }
    const bridge = new ChatBridge(out, rt.agent, rt.file)
    const stop = new SlackSocket(api, bridge, rt.log).start()
    return () => {
      stop()
      bridge.close()
    }
  },
}

export const GATEWAY_PROVIDERS: GatewayProvider[] = [telegram, discord, slack]

export const findGateway = (id: string): GatewayProvider | undefined => GATEWAY_PROVIDERS.find((p) => p.id === id)
