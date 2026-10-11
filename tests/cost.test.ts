import { describe, expect, it } from 'vitest'
import { aggregateModelCalls, computeCost, formatUsd, unknownCost } from '../src/llm/cost.js'
import { normalizeUsage } from '../src/llm/usage.js'
import { findModel, listModels } from '../src/llm/registry.js'
import type { ModelCallRecord } from '../src/core/types.js'

describe('computeCost', () => {
  it('computes per-component cost from explicit pricing (gpt-4o: $2.5 in / $10 out / $1.25 cached per 1M)', () => {
    const usage = normalizeUsage({ totalInput: 1_000_000, cachedInput: 400_000, output: 100_000 })
    const cost = computeCost(usage, null, 'gpt-4o', 'openai')
    expect(cost.inputUsd).toBeCloseTo(1.5, 10) // 600k * $2.5/1M
    expect(cost.cachedInputUsd).toBeCloseTo(0.5, 10) // 400k * $1.25/1M
    expect(cost.outputUsd).toBeCloseTo(1.0, 10) // 100k * $10/1M
    expect(cost.totalUsd).toBeCloseTo(3.0, 10)
    expect(cost.partial).toBe(false)
    expect(cost.reason).toBe('')
  })

  it('unknown model → null cost with a reason, NEVER zero', () => {
    const usage = normalizeUsage({ totalInput: 1000, output: 100 })
    const cost = computeCost(usage, null, 'some-provider/mystery-model-x', 'openai')
    expect(cost.totalUsd).toBeNull()
    expect(cost.reason).toMatch(/pricing unknown/i)
  })

  it('registered model without pricing → null cost, not zero', () => {
    const usage = normalizeUsage({ totalInput: 1000, output: 100 })
    const spec = {
      id: 'no-price-model',
      providerId: 'openai-compatible' as const,
      // no pricing field at all
    }
    const cost = computeCost(usage, spec, 'no-price-model')
    expect(cost.totalUsd).toBeNull()
    expect(cost.reason).toMatch(/no published pricing/i)
  })

  it('no usage reported at all → null cost with an explicit reason', () => {
    const cost = computeCost(normalizeUsage({}), null, 'gpt-4o', 'openai')
    expect(cost.totalUsd).toBeNull()
    expect(cost.reason).toMatch(/no token usage/i)
  })

  it('a missing token count makes the cost partial, not silently under-reported', () => {
    const usage = normalizeUsage({ totalInput: 100_000 }) // output unknown
    const cost = computeCost(usage, null, 'gpt-4o', 'openai')
    expect(cost.inputUsd).toBeCloseTo(0.25, 10)
    expect(cost.outputUsd).toBeNull()
    expect(cost.partial).toBe(true)
    expect(cost.reason).toMatch(/partial/i)
  })

  it('cache-write falls back to the input rate when no dedicated rate is published', () => {
    // gpt-4o has no cacheWritePer1M in the registry.
    const usage = normalizeUsage({ input: 0, cachedInput: 0, cacheWrite: 1_000_000, output: 0 })
    const cost = computeCost(usage, null, 'gpt-4o', 'openai')
    expect(cost.cacheWriteUsd).toBeCloseTo(2.5, 10) // input rate
    expect(cost.totalUsd).toBeCloseTo(2.5, 10)
  })
})

describe('registry safety', () => {
  it('never guesses a model that is not registered', () => {
    expect(findModel('totally-unknown-model-9000')).toBeNull()
  })

  it('every registered model with pricing has non-negative finite rates', () => {
    for (const model of listModels()) {
      if (!model.pricing) continue
      for (const rate of Object.values(model.pricing)) {
        expect(rate).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(rate)).toBe(true)
      }
    }
  })
})

describe('aggregateModelCalls', () => {
  function call(over: Partial<ModelCallRecord>): ModelCallRecord {
    return {
      at: new Date().toISOString(),
      model: 'gpt-4o',
      providerId: 'openai',
      turn: 1,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      usageSource: 'provider',
      costUsd: null,
      costPartial: false,
      ...over,
    }
  }

  it('sums the ledger exactly once per record and is idempotent', () => {
    const calls = [
      call({ inputTokens: 1000, outputTokens: 100, costUsd: 0.0035 }),
      call({ inputTokens: 2000, outputTokens: 300, costUsd: 0.008 }),
    ]
    const totals = aggregateModelCalls(calls)
    expect(totals.inputTokens).toBe(3000)
    expect(totals.outputTokens).toBe(400)
    expect(totals.costUsd).toBeCloseTo(0.0115, 10)
    expect(totals.costPartial).toBe(false)
    expect(totals.unpricedCalls).toBe(0)
    // Re-deriving from the same ledger yields the same numbers (no accumulation).
    expect(aggregateModelCalls(calls)).toEqual(totals)
  })

  it('an empty ledger gives null totals — an idle session did not spend $0, it spent unknown', () => {
    const totals = aggregateModelCalls([])
    expect(totals.costUsd).toBeNull()
    expect(totals.inputTokens).toBeNull()
  })

  it('mixed priced/unpriced calls: partial sum with an explicit unpriced count', () => {
    const calls = [
      call({ inputTokens: 1000, outputTokens: 100, costUsd: 0.0035 }),
      call({ inputTokens: null, outputTokens: null, costUsd: null, costNote: 'no usage reported' }),
    ]
    const totals = aggregateModelCalls(calls)
    expect(totals.costUsd).toBeCloseTo(0.0035, 10)
    expect(totals.costPartial).toBe(true)
    expect(totals.unpricedCalls).toBe(1)
  })

  it('all-unpriced ledger → null cost, not 0', () => {
    const totals = aggregateModelCalls([call({}), call({})])
    expect(totals.costUsd).toBeNull()
    expect(totals.unpricedCalls).toBe(2)
  })
})

describe('formatUsd', () => {
  it('renders unknown as the word, never as $0.00', () => {
    expect(formatUsd(null)).toBe('unknown')
    expect(formatUsd(0)).toBe('$0.00') // an actual measured zero stays $0.00
    expect(formatUsd(0.0035)).toBe('$0.0035')
    expect(formatUsd(1.5)).toBe('$1.5000')
  })

  it('unknownCost carries the reason through', () => {
    const cost = unknownCost('why')
    expect(cost.totalUsd).toBeNull()
    expect(cost.reason).toBe('why')
    expect(cost.partial).toBe(false)
  })
})
