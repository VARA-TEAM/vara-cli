/**
 * Normalized token usage.
 *
 * Providers report usage with different names and different billing semantics.
 * We normalize into ONE shape, and we keep the provenance so a number is never
 * silently trusted:
 *
 *   - `inputTokens`       regular billed input tokens, EXCLUDING cached tokens
 *   - `cachedInputTokens` input tokens served from the provider cache (cheaper)
 *   - `cacheWriteTokens`  input tokens written INTO the provider cache (pricier)
 *   - `outputTokens`      generated tokens
 *   - `totalInputTokens`  the provider's own total input, kept verbatim for audit
 *
 * The cached/cache-write counts are NEVER added on top of `inputTokens` when the
 * provider already folded them into its total — `normalizeUsage()` takes the
 * provider's totals and subtracts, so a token is billed exactly once.
 *
 * Every field is `number | null`. `null` means "the provider did not tell us".
 * It is never coerced to 0, because 0 tokens and unknown tokens are different
 * facts and conflating them would fabricate cost figures.
 */

export type UsageSource = 'provider' | 'estimated'

export interface NormalizedUsage {
  /** Regular billed input tokens (cached and cache-write already removed). */
  inputTokens: number | null
  /** Generated tokens. */
  outputTokens: number | null
  /** Input tokens served from the provider's cache (billed at a lower rate). */
  cachedInputTokens: number | null
  /** Input tokens written into the provider's cache (billed at a higher rate). */
  cacheWriteTokens: number | null
  /** The provider's own reported total input, verbatim, for audit/verification. */
  reportedTotalInputTokens: number | null
  /** Where these numbers came from. */
  source: UsageSource
  /** True when at least the basic input/output pair was present and usable. */
  complete: boolean
}

export function emptyUsage(source: UsageSource = 'provider'): NormalizedUsage {
  return {
    inputTokens: null,
    outputTokens: null,
    cachedInputTokens: null,
    cacheWriteTokens: null,
    reportedTotalInputTokens: null,
    source,
    complete: false,
  }
}

/**
 * Coerce an unknown value into a non-negative finite integer, or null.
 * Rejects NaN, Infinity, negatives, and non-numbers — a malformed number must
 * never become a fabricated token count.
 */
export function toTokenCount(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  if (value < 0) return null
  return Math.trunc(value)
}

export interface UsageInput {
  /** Provider total input tokens, if reported. */
  totalInput?: unknown
  /** Normal (non-cached) input tokens, if the provider reports them separately. */
  input?: unknown
  /** Cached / cache-read input tokens. */
  cachedInput?: unknown
  /** Cache creation / cache-write tokens. */
  cacheWrite?: unknown
  /** Output / completion tokens. */
  output?: unknown
  source?: UsageSource
}

/**
 * Build a normalized usage record from provider-reported raw fields.
 *
 * Handles the two shapes providers actually use:
 *   1. `prompt_tokens` already includes cached tokens  → cached are a SUBSET
 *   2. `input_tokens` + `cache_read_input_tokens` reported separately
 *
 * In shape (1) we subtract the cached count from the total so nothing is billed
 * twice. In shape (2) we take the explicit input count as-is.
 */
export function normalizeUsage(raw: UsageInput): NormalizedUsage {
  const source = raw.source ?? 'provider'
  const total = toTokenCount(raw.totalInput)
  const explicitInput = toTokenCount(raw.input)
  const cached = toTokenCount(raw.cachedInput)
  const cacheWrite = toTokenCount(raw.cacheWrite)
  const output = toTokenCount(raw.output)

  let input: number | null = null
  if (explicitInput !== null) {
    // Shape (2): input_tokens is the regular (non-cached) count.
    input = explicitInput
  } else if (total !== null) {
    // Shape (1): total includes the cached subset — subtract it out.
    input = Math.max(0, total - (cached ?? 0) - (cacheWrite ?? 0))
  }

  const complete = input !== null && output !== null
  return {
    inputTokens: input,
    outputTokens: output,
    cachedInputTokens: cached,
    cacheWriteTokens: cacheWrite,
    reportedTotalInputTokens: total ?? explicitInput,
    source,
    complete,
  }
}

/** True when the record carries no usable numbers at all. */
export function isEmptyUsage(usage: NormalizedUsage): boolean {
  return (
    usage.inputTokens === null &&
    usage.outputTokens === null &&
    usage.cachedInputTokens === null &&
    usage.cacheWriteTokens === null
  )
}
