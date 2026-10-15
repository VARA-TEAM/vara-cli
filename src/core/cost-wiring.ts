import type { VaraConfig } from '../config/config.js'
import { createProvider, type Provider } from '../llm/provider.js'
import { resolveApiKey } from '../runtime.js'
import { normaliseTarget, type RouterSettings } from './router.js'
import { sharedMeter, type LimitsConfig } from './usage-meter.js'
import type { EngineOptions } from './engine.js'

/** Router settings from the user's config (read live). */
export function routerFromConfig(config: VaraConfig): RouterSettings {
  const r = config.routing
  const tiers: RouterSettings['tiers'] = {}
  for (const k of ['strong', 'standard', 'cheap'] as const) {
    const t = normaliseTarget(r.tiers[k])
    if (t) tiers[k] = t
  }
  return { enabled: r.enabled, tiers, floor: r.floor, escalateOnFailure: r.escalateOnFailure, eco: false }
}

export function limitsFromConfig(config: VaraConfig): LimitsConfig {
  return config.limits as LimitsConfig
}

const lazy = new Map<string, Provider>()

/**
 * A provider other than the active one, by its name in `config.providers`.
 * The key is resolved on first use (vault, then env), so building it costs
 * nothing and a missing key shows up as an error on the call that needs it.
 */
export function providerByName(config: VaraConfig, name: string): Provider | undefined {
  const entry = config.providers[name]
  if (!entry) return undefined
  const cacheKey = `${name}|${entry.type}|${entry.baseUrl}`
  const hit = lazy.get(cacheKey)
  if (hit) return hit
  const p: Provider = {
    id: entry.type,
    async *chat(req) {
      let inner: Provider
      try {
        const apiKey = await resolveApiKey(entry)
        inner = createProvider({ id: entry.type, baseUrl: entry.baseUrl || (entry.type === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'), apiKey, model: req.model })
      } catch (err) {
        yield { type: 'error', message: (err as Error).message }
        return
      }
      yield* inner.chat(req)
    },
  }
  lazy.set(cacheKey, p)
  return p
}

/** Everything the cost engine needs from the engine options, in one spread. */
export function costExtras(config: () => VaraConfig): Pick<EngineOptions, 'router' | 'providerFor' | 'meter' | 'limits' | 'costSettings'> {
  return {
    router: () => routerFromConfig(config()),
    providerFor: (name) => providerByName(config(), name),
    meter: sharedMeter(),
    limits: () => limitsFromConfig(config()),
    costSettings: () => {
      const c = config().context
      return { summarize: c.summarize, toolOutputChars: c.toolOutputChars, smartRead: c.smartRead }
    },
  }
}
