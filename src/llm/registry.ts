import { resolveWindow } from '../core/context.js'

/**
 * Minimal model registry.
 *
 * Only the fields this milestone needs: identity, limits, and PRICING.
 * Everything is optional and explicit. We never invent a price, a context
 * window, or a capability: an absent field means "unknown", and the cost layer
 * reports `null` rather than a fabricated number.
 *
 * Pricing is USD per 1,000,000 tokens, matching how providers publish rates.
 * Each entry carries an `asOf` date so a stale price is visible as stale.
 */

export interface ModelPricing {
  /** USD per 1M regular input tokens. */
  inputPer1M: number
  /** USD per 1M generated tokens. */
  outputPer1M: number
  /** USD per 1M cached input tokens (cache read). Falls back to inputPer1M when absent. */
  cachedInputPer1M?: number
  /** USD per 1M cache-write tokens. Falls back to inputPer1M when absent. */
  cacheWritePer1M?: number
}

export interface ModelSpec {
  /** Canonical model id as the provider expects it. */
  id: string
  providerId: 'openai' | 'anthropic' | 'openai-compatible'
  /** Context window in tokens, when known. */
  contextWindow?: number
  /** Maximum output tokens the model accepts, when known. */
  maxOutputTokens?: number
  supportsTools?: boolean
  pricing?: ModelPricing
  /** When the pricing above was last confirmed. */
  pricingAsOf?: string
}

/**
 * Registry entries we are confident about. Deliberately conservative: a wrong
 * price is worse than no price, because a wrong price silently corrupts the
 * cost signal the whole efficiency engine will be built on.
 */
const MODELS: ModelSpec[] = [
  {
    id: 'gpt-4o',
    providerId: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    pricing: { inputPer1M: 2.5, outputPer1M: 10, cachedInputPer1M: 1.25 },
    pricingAsOf: '2024-11-01',
  },
  {
    id: 'gpt-4o-mini',
    providerId: 'openai',
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    supportsTools: true,
    pricing: { inputPer1M: 0.15, outputPer1M: 0.6, cachedInputPer1M: 0.075 },
    pricingAsOf: '2024-11-01',
  },
  {
    id: 'gpt-4.1',
    providerId: 'openai',
    contextWindow: 1_000_000,
    maxOutputTokens: 32_768,
    supportsTools: true,
    pricing: { inputPer1M: 2.0, outputPer1M: 8.0, cachedInputPer1M: 0.5 },
    pricingAsOf: '2025-04-14',
  },
  {
    id: 'claude-3-5-sonnet',
    providerId: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    pricing: { inputPer1M: 3, outputPer1M: 15, cachedInputPer1M: 0.3, cacheWritePer1M: 3.75 },
    pricingAsOf: '2024-10-22',
  },
  {
    id: 'claude-3-5-haiku',
    providerId: 'anthropic',
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    supportsTools: true,
    pricing: { inputPer1M: 0.8, outputPer1M: 4, cachedInputPer1M: 0.08, cacheWritePer1M: 1 },
    pricingAsOf: '2024-11-04',
  },
]

/**
 * Find a registry entry for a model id. Matching is exact after normalisation,
 * then a longest-prefix match so `gpt-4o-2024-08-06` resolves to `gpt-4o`
 * pricing. Returns null when nothing matches — we do not guess.
 */
export function findModel(modelId: string, providerId?: string): ModelSpec | null {
  if (!modelId) return null
  const id = modelId.trim().toLowerCase()
  const candidates = providerId
    ? MODELS.filter((m) => m.providerId === providerId || m.providerId === 'openai-compatible')
    : MODELS

  const pool = candidates.length ? candidates : MODELS

  const exact = pool.find((m) => m.id.toLowerCase() === id)
  if (exact) return exact

  // Longest prefix match: "gpt-4o-2024-08-06" → "gpt-4o".
  let best: ModelSpec | null = null
  for (const m of pool) {
    const base = m.id.toLowerCase()
    if (id.startsWith(base) && (!best || base.length > best.id.length)) best = m
  }
  return best
}

/** All registered models, for `/models` style listings and router input. */
export function listModels(): ModelSpec[] {
  return [...MODELS]
}

/** Context window: registry entry first, then the context.ts heuristic, else null. */
export function contextWindowFor(modelId: string, providerId?: string): number | null {
  const spec = findModel(modelId, providerId)
  if (spec?.contextWindow) return spec.contextWindow
  // Reuse the existing conservative heuristic (returns a marked fallback).
  const { windowTokens, source } = resolveWindow(modelId, { maxOutputTokens: 4096 })
  return source === 'fallback' ? null : windowTokens
}
