import { findModel, type ModelPricing, type ModelSpec } from './registry.js'
import { toTokenCount, type NormalizedUsage } from './usage.js'
import type { ModelCallRecord } from '../core/types.js'

/**
 * Cost accounting.
 *
 * The single most important rule here: MISSING DATA IS `null`, NOT `0`.
 * A session whose model has no published price must show "cost unknown", never
 * "$0.00" — otherwise the efficiency engine would "prove" savings that do not
 * exist. Similarly a partially-known usage record yields a partial cost with an
 * explicit flag, rather than a confidently wrong total.
 */

export interface CostBreakdown {
  /** USD spent on regular input tokens. */
  inputUsd: number | null
  /** USD spent on generated tokens. */
  outputUsd: number | null
  /** USD spent on cache-read tokens. */
  cachedInputUsd: number | null
  /** USD spent on cache-write tokens. */
  cacheWriteUsd: number | null
  /** Total USD, or null when it cannot be computed. */
  totalUsd: number | null
  /** True when at least one priced component was missing and total is partial. */
  partial: boolean
  /** Why the cost is unknown or partial (empty when fully known). */
  reason: string
}

export function unknownCost(reason: string): CostBreakdown {
  return {
    inputUsd: null,
    outputUsd: null,
    cachedInputUsd: null,
    cacheWriteUsd: null,
    totalUsd: null,
    partial: false,
    reason,
  }
}

/** USD for a token count at a per-1M rate. Either input may be null → null. */
function line(tokens: number | null, per1M: number | undefined): number | null {
  if (tokens === null) return null
  if (per1M === undefined) return null
  const value = (tokens / 1_000_000) * per1M
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * Compute cost for one model call.
 *
 * A component that was not reported by the provider contributes `null` to the
 * total (we don't assume it was zero), so a call with unknown output tokens is
 * flagged `partial` instead of silently under-reporting.
 */
export function computeCost(
  usage: NormalizedUsage,
  model: ModelSpec | null,
  modelId: string,
  providerId?: string,
): CostBreakdown {
  const spec = model ?? findModel(modelId, providerId)
  if (!spec) {
    return unknownCost(`No registry entry for model "${modelId}" — pricing unknown.`)
  }
  const pricing: ModelPricing | undefined = spec.pricing
  if (!pricing) {
    return unknownCost(`Model "${spec.id}" is registered but has no published pricing.`)
  }

  const inputUsd = line(usage.inputTokens, pricing.inputPer1M)
  const outputUsd = line(usage.outputTokens, pricing.outputPer1M)
  const cachedInputUsd = line(usage.cachedInputTokens, pricing.cachedInputPer1M ?? pricing.inputPer1M)
  const cacheWriteUsd = line(usage.cacheWriteTokens, pricing.cacheWritePer1M ?? pricing.inputPer1M)

  const priced = [inputUsd, outputUsd, cachedInputUsd, cacheWriteUsd].filter((p): p is number => p !== null)

  // The total is PARTIAL — not a complete picture — when:
  //   (a) a core token count (input/output) was never reported, or
  //   (b) a reported token count has no matching rate to price it.
  // Missing cache counts alone do not make it partial: providers that do no
  // caching often omit them, and they are optional extras on top of input.
  const missingCore = usage.inputTokens === null || usage.outputTokens === null
  const rateGap =
    (usage.inputTokens !== null && pricing.inputPer1M === undefined) ||
    (usage.outputTokens !== null && pricing.outputPer1M === undefined) ||
    (usage.cachedInputTokens !== null && pricing.cachedInputPer1M === undefined && pricing.inputPer1M === undefined) ||
    (usage.cacheWriteTokens !== null && pricing.cacheWritePer1M === undefined && pricing.inputPer1M === undefined)

  // Unknown is never zero: with nothing priced the total is null, not $0.
  const totalUsd = priced.length === 0 ? null : priced.reduce((sum, p) => sum + p, 0)
  const partial = totalUsd !== null && (missingCore || rateGap)

  const reason =
    totalUsd === null
      ? 'No token usage was reported for this call.'
      : partial
        ? 'Cost is partial: some token counts were unreported or have no matching rate.'
        : ''

  return {
    inputUsd,
    outputUsd,
    cachedInputUsd,
    cacheWriteUsd,
    totalUsd,
    partial,
    reason,
  }
}

export function toTokenCountOrNull(v: unknown): number | null {
  return toTokenCount(v)
}

export function formatUsd(value: number | null): string {
  if (value === null) return 'unknown'
  if (value === 0) return '$0.00'
  if (value < 0.01) return `$${value.toFixed(5).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${value.toFixed(4)}`
}

export function formatTokensOrUnknown(value: number | null): string {
  if (value === null) return 'unknown'
  if (value >= 1000) return `${Math.round(value / 1000)}k`
  return String(value)
}

export interface AggregatedUsage {
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  costUsd: number | null
  costPartial: boolean
  unpricedCalls: number
}

/**
 * Derive session totals from the per-call ledger.
 *
 * The ledger is the source of truth; totals are ALWAYS recomputed from it,
 * never incremented in place. That makes aggregation idempotent: running this
 * after save → resume → more calls → save again can never double-count, and a
 * stale snapshot total is always self-healed from the auditable records.
 *
 * Rules:
 *   - A token total is `null` when NO record reported it (unknown, not zero).
 *     When only some records reported, the sum of the known subset is kept —
 *     the missing part is visible through `unpricedCalls`/`costPartial`.
 *   - Cost totals sum only records with a known cost. If at least one call has
 *     an unknown cost, `costPartial` is true; if ALL are unknown, `costUsd` is
 *     null — never $0.
 */
export function aggregateModelCalls(calls: readonly ModelCallRecord[]): AggregatedUsage {
  const sumField = (field: keyof Pick<ModelCallRecord, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteTokens'>): number | null => {
    let total = 0
    let any = false
    for (const call of calls) {
      const v = call[field]
      if (v !== null) {
        total += v
        any = true
      }
    }
    return any ? total : null
  }

  let costSum = 0
  let priced = 0
  let unpriced = 0
  for (const call of calls) {
    if (call.costUsd === null || !Number.isFinite(call.costUsd)) {
      unpriced += 1
    } else {
      costSum += call.costUsd
      priced += 1
    }
  }

  return {
    inputTokens: sumField('inputTokens'),
    outputTokens: sumField('outputTokens'),
    cachedInputTokens: sumField('cachedInputTokens'),
    cacheWriteTokens: sumField('cacheWriteTokens'),
    costUsd: priced > 0 ? costSum : null,
    costPartial: unpriced > 0,
    unpricedCalls: unpriced,
  }
}
