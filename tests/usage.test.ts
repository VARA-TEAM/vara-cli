import { describe, expect, it } from 'vitest'
import { emptyUsage, isEmptyUsage, normalizeUsage, toTokenCount } from '../src/llm/usage.js'

describe('normalizeUsage', () => {
  it('subtracts the cached subset from the total so cached tokens are never billed twice', () => {
    // OpenAI shape: prompt_tokens INCLUDES cached_tokens.
    const usage = normalizeUsage({
      totalInput: 1000,
      cachedInput: 400,
      output: 250,
      source: 'provider',
    })
    expect(usage.inputTokens).toBe(600) // 1000 - 400, not 1000
    expect(usage.cachedInputTokens).toBe(400)
    expect(usage.outputTokens).toBe(250)
    expect(usage.reportedTotalInputTokens).toBe(1000)
    expect(usage.complete).toBe(true)
  })

  it('subtracts cache-write tokens too when they are folded into the total', () => {
    const usage = normalizeUsage({ totalInput: 1500, cachedInput: 300, cacheWrite: 200, output: 100 })
    expect(usage.inputTokens).toBe(1000) // 1500 - 300 - 200
    expect(usage.cacheWriteTokens).toBe(200)
  })

  it('takes the explicit input count as-is in the Anthropic shape (already exclusive)', () => {
    // Anthropic shape: input_tokens EXCLUDES both cache counts.
    const usage = normalizeUsage({
      input: 500,
      cachedInput: 200,
      cacheWrite: 100,
      output: 80,
      source: 'provider',
    })
    expect(usage.inputTokens).toBe(500) // no subtraction
    expect(usage.cachedInputTokens).toBe(200)
    expect(usage.cacheWriteTokens).toBe(100)
    expect(usage.outputTokens).toBe(80)
  })

  it('keeps every field null when nothing was reported — unknown is not zero', () => {
    const usage = normalizeUsage({})
    expect(usage.inputTokens).toBeNull()
    expect(usage.outputTokens).toBeNull()
    expect(usage.cachedInputTokens).toBeNull()
    expect(usage.complete).toBe(false)
    expect(isEmptyUsage(usage)).toBe(true)
  })

  it('marks usage incomplete when only one of input/output was reported', () => {
    const usage = normalizeUsage({ totalInput: 100 })
    expect(usage.inputTokens).toBe(100)
    expect(usage.outputTokens).toBeNull()
    expect(usage.complete).toBe(false)
  })
})

describe('toTokenCount', () => {
  it('accepts non-negative finite numbers and truncates fractions', () => {
    expect(toTokenCount(42)).toBe(42)
    expect(toTokenCount(42.9)).toBe(42)
    expect(toTokenCount(0)).toBe(0)
  })

  it('rejects NaN, Infinity, negatives and non-numbers — a malformed value never becomes a token count', () => {
    expect(toTokenCount(Number.NaN)).toBeNull()
    expect(toTokenCount(Number.POSITIVE_INFINITY)).toBeNull()
    expect(toTokenCount(-5)).toBeNull()
    expect(toTokenCount('123')).toBeNull()
    expect(toTokenCount(null)).toBeNull()
    expect(toTokenCount(undefined)).toBeNull()
    expect(toTokenCount({})).toBeNull()
  })

  it('malformed usage objects do not throw', () => {
    expect(() => normalizeUsage({ totalInput: 'abc', output: {}, cachedInput: null })).not.toThrow()
    const usage = normalizeUsage({ totalInput: 'abc', output: {}, cachedInput: null })
    expect(usage.inputTokens).toBeNull()
    expect(usage.outputTokens).toBeNull()
  })
})

describe('emptyUsage', () => {
  it('produces an all-null record that is explicitly not complete', () => {
    const usage = emptyUsage('provider')
    expect(usage.source).toBe('provider')
    expect(usage.complete).toBe(false)
    expect(isEmptyUsage(usage)).toBe(true)
  })
})
