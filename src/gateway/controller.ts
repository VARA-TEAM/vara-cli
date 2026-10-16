import type { VaraConfig } from '../config/config.js'
import { TelegramApi } from './telegram-api.js'
import { pairingStatus, startPairing, unpair } from './telegram-bridge.js'

export interface GatewayStatus {
  telegram: {
    hasToken: boolean
    enabled: boolean
    running: boolean
    paired: boolean
    /** A pairing code waiting to be used (one time, expires). */
    pairing?: { code: string; expiresAt: number }
    bot?: string
  }
}

/** What the settings screens (browser and terminal) can do with the messaging gateways. */
export interface GatewayControl {
  status(): Promise<GatewayStatus>
  /** Check the token with Telegram, keep it in the vault, and start the bridge if it is switched on. */
  setToken(token: string): Promise<{ bot: string }>
  /** Start or stop the bridge to match `config.gateway.telegram.enabled` (call it after changing the config). */
  reconcile(): Promise<void>
  pair(): Promise<{ code: string; minutes: number }>
  unpair(): Promise<void>
  /** Stop the bridge (the host is shutting down). */
  stop(): void
}

export interface GatewayDeps {
  config(): VaraConfig
  token(): Promise<string | null>
  saveToken(token: string): Promise<void>
  /** Starts the polling loop; returns what stops it. */
  start(token: string): () => void
  fetchImpl?: typeof fetch
}

/**
 * Owns the one running Telegram bridge. Turning the gateway on or off, or replacing its token, takes effect at once:
 * no restart. A token is shown to nobody afterwards; only "a token is set" and the bot's name are.
 */
export function makeGatewayControl(d: GatewayDeps): GatewayControl {
  let stop: (() => void) | null = null
  let bot: string | undefined
  return {
    async status() {
      const pair = await pairingStatus()
      return {
        telegram: {
          hasToken: !!(await d.token()),
          enabled: d.config().gateway.telegram.enabled,
          running: stop !== null,
          paired: pair.paired,
          ...(pair.code && pair.expiresAt ? { pairing: { code: pair.code, expiresAt: pair.expiresAt } } : {}),
          ...(bot ? { bot } : {}),
        },
      }
    },
    async setToken(token) {
      const clean = token.trim()
      if (!/^\d{5,}:[\w-]{20,}$/.test(clean)) throw new Error('That does not look like a bot token (it is like 123456789:AA… and comes from @BotFather).')
      const me = await new TelegramApi(clean, d.fetchImpl).getMe().catch((e: Error) => {
        throw new Error(`Telegram did not accept that token (${e.message}).`)
      })
      await d.saveToken(clean)
      bot = me.username ? `@${me.username}` : me.first_name ?? 'your bot'
      await this.reconcile()
      return { bot }
    },
    async reconcile() {
      const want = d.config().gateway.telegram.enabled
      const token = want ? await d.token() : null
      stop?.()
      stop = null
      if (want && token) stop = d.start(token)
    },
    async pair() {
      if (!(await d.token())) throw new Error('Add the bot token first.')
      return startPairing()
    },
    async unpair() {
      await unpair()
    },
    stop() {
      stop?.()
      stop = null
    },
  }
}
