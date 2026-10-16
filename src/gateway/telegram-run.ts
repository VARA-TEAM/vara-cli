import type { VaraHost } from '../server/host.js'
import { getSecretsForScope, setSecret } from '../security/vault.js'
import { registerSecret } from '../security/redact.js'
import { loadConfig, persistConfig } from '../config/config.js'
import { askHidden } from '../mcp/connectors-cli.js'
import { pairingStatus } from './telegram-bridge.js'
import { TelegramApi } from './telegram-api.js'
import { TelegramBridge, startPairing, unpair, type AgentPort } from './telegram-bridge.js'

const OWNER = { kind: 'owner' } as const
const TOKEN_NAME = 'TELEGRAM_BOT_TOKEN'

/** The bot token: the environment first, then the vault (`vara secret set TELEGRAM_BOT_TOKEN`). */
export async function telegramToken(): Promise<string | null> {
  const fromEnv = process.env[TOKEN_NAME]?.trim()
  if (fromEnv) return fromEnv
  const secrets = await getSecretsForScope('global').catch(() => ({}) as Record<string, string>)
  return secrets[TOKEN_NAME]?.trim() || null
}

/** The host seen as the bridge's port: the owner's own principal, so the usual permissions and approvals apply. */
export function hostAgentPort(host: VaraHost): AgentPort {
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  return {
    async create(message) {
      return must(await host.create(OWNER, { message, kind: 'auto' })).id
    },
    async send(id, text) {
      must(await host.send(OWNER, id, text))
    },
    async pause(id) {
      await host.pause(OWNER, id)
    },
    async undo(id) {
      const r = await host.undo(OWNER, id, 1)
      if (!r.ok) return r.error
      const lines = [...r.value.restored.map((x) => `${x.path}: ${x.what}`), ...r.value.failed.map((x) => `${x.path}: ${x.why}`)]
      return lines.length ? lines.join('\n') : 'Nothing to undo.'
    },
    async resolveApproval(id, approvalId, approved) {
      await host.resolveApproval(OWNER, id, approvalId, approved)
    },
    async watch(id, events) {
      // After a huge id: nothing from the past is replayed, only what happens from now on.
      const sub = must(
        await host.subscribe(OWNER, id, Number.MAX_SAFE_INTEGER, {
          send: ({ event }) => {
            const e = event as unknown as Record<string, unknown>
            if (e['type'] === 'text' && typeof e['delta'] === 'string') events.onText(e['delta'])
            else if (e['type'] === 'state') events.onState(String(e['state']), typeof e['reason'] === 'string' ? e['reason'] : undefined)
            else if (e['type'] === 'approval_request') events.onApproval(e['request'] as { id: string; title: string; detail: string })
            else if (e['type'] === 'completed' && typeof e['summary'] === 'string') events.onCompleted(e['summary'])
          },
          close: () => {},
        }),
      )
      return sub.unsubscribe
    },
  }
}

/** Start the long-polling loop. Returns a function that stops it. */
export function startTelegram(opts: { token: string; host: VaraHost; log: (line: string) => void; fetchImpl?: typeof fetch; base?: string }): () => void {
  const api = new TelegramApi(opts.token, opts.fetchImpl, opts.base)
  const bridge = new TelegramBridge(api, hostAgentPort(opts.host))
  const abort = new AbortController()
  let offset = 0
  void (async () => {
    opts.log('Telegram bridge on: pair it with `vara gateway telegram pair`')
    while (!abort.signal.aborted) {
      try {
        const updates = await api.getUpdates(offset, 25, abort.signal)
        for (const u of updates) {
          offset = Math.max(offset, u.update_id + 1)
          await bridge.handle(u)
        }
      } catch (err) {
        if (abort.signal.aborted) break
        opts.log(`Telegram: ${(err as Error).message} (retrying)`)
        await new Promise((r) => setTimeout(r, 3000))
      }
    }
  })()
  return () => {
    abort.abort()
    bridge.close()
  }
}

/** `vara gateway telegram pair | unpair | status` */
export async function gatewayCommand(args: string[]): Promise<void> {
  const [what, action] = args
  if (what !== 'telegram' || !['setup', 'pair', 'unpair', 'status'].includes(action ?? '')) {
    console.log('usage: vara gateway telegram setup | pair | unpair | status')
    return
  }
  if (action === 'unpair') {
    await unpair()
    console.log('Telegram chat disconnected.')
    return
  }
  if (action === 'setup') {
    console.log('1. In Telegram open @BotFather, send /newbot, and copy the token it gives you.')
    const token = await askHidden('2. Paste the token (it is not shown): ')
    if (!/^d{5,}:[w-]{20,}$/.test(token)) return void console.log('That does not look like a bot token.')
    try {
      const me = await new TelegramApi(token).getMe()
      await setSecret(TOKEN_NAME, token)
      registerSecret(token, TOKEN_NAME)
      const cfg = await loadConfig()
      await persistConfig({ ...cfg, gateway: { ...cfg.gateway, telegram: { ...cfg.gateway.telegram, enabled: true } } })
      const { code, minutes } = await startPairing()
      console.log(`Connected as @${me.username ?? me.first_name}. Telegram is switched on.
3. Start VARA as a host (vara serve, or vara ui), open your bot and send:  /pair ${code}
   The code works once and expires in ${minutes} minutes. A host that is already running: use Settings → Gateways in its web page, or restart it.`)
    } catch (err) {
      console.log(`Telegram did not accept that token: ${(err as Error).message}`)
    }
    return
  }
  const token = await telegramToken()
  if (action === 'status') {
    const cfg = await loadConfig()
    const p = await pairingStatus()
    console.log(`token: ${token ? 'set' : 'not set (vara gateway telegram setup)'} · switched on: ${cfg.gateway.telegram.enabled ? 'yes' : 'no'} · chat: ${p.paired ? 'paired' : p.code ? 'waiting for /pair ' + p.code : 'not paired'}`)
    console.log('The bridge runs inside `vara serve` / `vara ui`; Settings → Gateways in the web page does the same as this command.')
    return
  }
  if (!token) {
    console.log('No bot token yet. In Telegram talk to @BotFather, make a bot, then run: vara secret set TELEGRAM_BOT_TOKEN')
    return
  }
  const { code, minutes } = await startPairing()
  console.log(`Open your bot in Telegram and send:  /pair ${code}\nThe code works once and expires in ${minutes} minutes. The bridge must be running (vara serve, with gateway.telegram.enabled = true).`)
}
