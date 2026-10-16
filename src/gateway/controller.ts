import type { VaraConfig } from '../config/config.js'
import { gatewayFile, pairingStatus, startPairing, unpair, type AgentPort } from './chat-bridge.js'
import { GATEWAY_PROVIDERS, type GatewayProvider, type L } from './providers.js'

export interface GatewayProviderStatus {
  id: string
  name: string
  intro: L
  steps: L[]
  /** The values the person must give. `stored` says whether one is already in the vault (never its value). */
  fields: Array<{ name: string; label: L; help: L; stored: boolean }>
  enabled: boolean
  running: boolean
  paired: boolean
  /** A pairing code waiting to be used (one time, expires). */
  pairing?: { code: string; expiresAt: number }
  bot?: string
}

export interface GatewayStatus {
  providers: GatewayProviderStatus[]
}

/** What the settings screens (browser and terminal) can do with the messaging gateways. */
export interface GatewayControl {
  status(): Promise<GatewayStatus>
  /** Check the values with the platform, keep them in the vault, and (re)start the platform if it is switched on. */
  setSecrets(id: string, values: Record<string, string>): Promise<{ bot: string }>
  /** Start or stop every platform to match `config.gateway` (call it after changing the config). */
  reconcile(): Promise<void>
  pair(id: string): Promise<{ code: string; minutes: number }>
  unpair(id: string): Promise<void>
  /** Stop everything (the host is shutting down). */
  stop(): void
}

export interface GatewayDeps {
  config(): VaraConfig
  /** Every secret the gateways may need, by name (environment first, then the vault). */
  secrets(): Promise<Record<string, string>>
  saveSecret(name: string, value: string): Promise<void>
  agent(): AgentPort
  log(line: string): void
  fetchImpl?: typeof fetch
  providers?: GatewayProvider[]
  /** Where each platform keeps its pairing state (tests point this at a temporary folder). */
  fileFor?(id: string): string
}

/**
 * Owns the running platform bridges. Every platform is independent: the person sets up the ones they use, and turning
 * one on, off, or replacing its secrets takes effect at once, no restart. A secret is shown to nobody afterwards.
 */
export function makeGatewayControl(d: GatewayDeps): GatewayControl {
  const providers = d.providers ?? GATEWAY_PROVIDERS
  const fileFor = d.fileFor ?? gatewayFile
  const running = new Map<string, () => void>()
  const bots = new Map<string, string>()
  const find = (id: string): GatewayProvider => {
    const p = providers.find((x) => x.id === id)
    if (!p) throw new Error(`Unknown gateway "${id}".`)
    return p
  }
  const complete = (p: GatewayProvider, have: Record<string, string>): boolean => p.secrets.every((s) => !!have[s.name])
  const enabled = (id: string): boolean => (d.config().gateway as Record<string, { enabled: boolean } | undefined>)[id]?.enabled === true

  const self: GatewayControl = {
    async status() {
      const have = await d.secrets()
      const out: GatewayProviderStatus[] = []
      for (const p of providers) {
        const pair = await pairingStatus(fileFor(p.id))
        out.push({
          id: p.id,
          name: p.name,
          intro: p.intro,
          steps: p.steps,
          fields: p.secrets.map((s) => ({ name: s.name, label: s.label, help: s.help, stored: !!have[s.name] })),
          enabled: enabled(p.id),
          running: running.has(p.id),
          paired: pair.paired,
          ...(pair.code && pair.expiresAt ? { pairing: { code: pair.code, expiresAt: pair.expiresAt } } : {}),
          ...(bots.get(p.id) ? { bot: bots.get(p.id)! } : {}),
        })
      }
      return { providers: out }
    },
    async setSecrets(id, values) {
      const p = find(id)
      const have = await d.secrets()
      const next: Record<string, string> = { ...have }
      for (const s of p.secrets) {
        const given = (values[s.name] ?? '').trim()
        if (!given) continue
        if (!s.pattern.test(given)) throw new Error(`${s.label.en} does not look right (${s.help.en}).`)
        next[s.name] = given
      }
      const missing = p.secrets.filter((s) => !next[s.name])
      if (missing.length) throw new Error(`Still needed: ${missing.map((s) => s.label.en).join(', ')}.`)
      const bot = await p.verify(next, d.fetchImpl).catch((e: Error) => {
        throw new Error(`${p.name} did not accept it (${e.message}).`)
      })
      for (const s of p.secrets) if ((values[s.name] ?? '').trim()) await d.saveSecret(s.name, next[s.name]!)
      bots.set(id, bot)
      running.get(id)?.()
      running.delete(id)
      await self.reconcile()
      return { bot }
    },
    async reconcile() {
      const have = await d.secrets()
      for (const p of providers) {
        const want = enabled(p.id) && complete(p, have)
        if (!want && running.has(p.id)) {
          running.get(p.id)!()
          running.delete(p.id)
        } else if (want && !running.has(p.id)) {
          const secrets = Object.fromEntries(p.secrets.map((s) => [s.name, have[s.name]!]))
          running.set(p.id, p.start({ secrets, agent: d.agent(), file: fileFor(p.id), log: (l) => d.log(l), ...(d.fetchImpl ? { fetchImpl: d.fetchImpl } : {}) }))
          d.log(`${p.name} gateway on: pair it with a code (Settings → Gateways, or vara gateway ${p.id} pair)`)
        }
      }
    },
    async pair(id) {
      const p = find(id)
      if (!complete(p, await d.secrets())) throw new Error(`Add the ${p.name} token first.`)
      return startPairing(fileFor(id))
    },
    async unpair(id) {
      find(id)
      await unpair(fileFor(id))
    },
    stop() {
      for (const stop of running.values()) stop()
      running.clear()
    },
  }
  return self
}
