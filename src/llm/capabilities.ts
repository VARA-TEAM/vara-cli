/**
 * What can this model do about "thinking"? Detected from the model id and the
 * endpoint, never assumed: a model that is not recognised reports no support,
 * and the UI then hides the control instead of sending a parameter the
 * provider might reject.
 */

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high'

export interface ThinkSupport {
  /** Levels the user can choose, lowest first. */
  levels: ThinkLevel[]
  /** Level used when the user chose nothing. */
  default: ThinkLevel
  /** How the level reaches the provider. */
  mechanism: 'effort' | 'budget' | 'openrouter'
  note: string
}

export const THINK_ORDER: ThinkLevel[] = ['off', 'low', 'medium', 'high']

/** Extended-thinking token budgets for budget-based providers (Anthropic). */
export const THINK_BUDGET: Record<Exclude<ThinkLevel, 'off'>, number> = { low: 2_048, medium: 8_192, high: 24_000 }

export interface ModelRef {
  /** Wire protocol of the provider entry. */
  type: 'openai' | 'anthropic'
  baseUrl: string
  model: string
  /** From the provider's own model list (OpenRouter `supported_parameters`), when known. */
  reasoningHint?: boolean
}

export function thinkingSupport(ref: ModelRef): ThinkSupport | null {
  const id = ref.model.toLowerCase()
  const base = ref.baseUrl.toLowerCase()

  if (ref.type === 'anthropic') {
    // Extended thinking: Claude 3.7 and every 4.x+ family.
    if (/claude-(3[-.]7|(sonnet|opus|haiku)-[4-9]|[4-9][-.]\d|[4-9]-)/.test(id) || /claude-[a-z]+-[4-9]/.test(id)) {
      return { levels: ['off', 'low', 'medium', 'high'], default: 'off', mechanism: 'budget', note: 'extended thinking (token budget)' }
    }
    return null
  }

  if (base.includes('openrouter.ai')) {
    if (ref.reasoningHint === false) return null
    if (ref.reasoningHint || /(o[134](-|$)|gpt-5|claude-(3[-.]7|(sonnet|opus|haiku)-[4-9])|gemini-2\.5|deepseek-r1|qwen3|grok-[34]|reasoner|thinking)/.test(id)) {
      return { levels: ['off', 'low', 'medium', 'high'], default: 'off', mechanism: 'openrouter', note: 'reasoning effort via OpenRouter' }
    }
    return null
  }

  // OpenAI reasoning families.
  if (/(^|\/)(o[134](-|$)|gpt-5)/.test(id)) {
    return { levels: ['low', 'medium', 'high'], default: 'medium', mechanism: 'effort', note: 'reasoning effort' }
  }
  // Gemini through its OpenAI-compatible endpoint.
  if (base.includes('generativelanguage.googleapis.com') && /gemini-2\.5/.test(id)) {
    return { levels: ['off', 'low', 'medium', 'high'], default: 'medium', mechanism: 'effort', note: 'thinking budget' }
  }
  return null
}

/** Clamp a stored level to what the model supports. */
export function effectiveLevel(support: ThinkSupport | null, chosen: ThinkLevel | undefined): ThinkLevel | undefined {
  if (!support) return undefined
  if (!chosen) return support.default
  return support.levels.includes(chosen) ? chosen : support.default
}

/** Next level in the model's own list (wraps around). */
export function nextLevel(support: ThinkSupport, current: ThinkLevel | undefined): ThinkLevel {
  const cur = effectiveLevel(support, current) ?? support.default
  const i = support.levels.indexOf(cur)
  return support.levels[(i + 1) % support.levels.length]!
}

/**
 * Request-body fields for an OpenAI-compatible endpoint. Empty when the model
 * has no thinking control — nothing unknown is ever sent.
 */
export function openaiThinkingParams(ref: ModelRef, level: ThinkLevel | undefined): Record<string, unknown> {
  const support = thinkingSupport(ref)
  const eff = effectiveLevel(support, level)
  if (!support || !eff) return {}
  if (support.mechanism === 'openrouter') {
    return eff === 'off' ? { reasoning: { effort: 'low', exclude: true } } : { reasoning: { effort: eff } }
  }
  if (eff === 'off') return ref.baseUrl.includes('generativelanguage') ? { reasoning_effort: 'none' } : {}
  return { reasoning_effort: eff }
}

/** Anthropic extended-thinking field, or null for "off / unsupported". */
export function anthropicThinking(ref: ModelRef, level: ThinkLevel | undefined): { type: 'enabled'; budget_tokens: number } | null {
  const support = thinkingSupport(ref)
  const eff = effectiveLevel(support, level)
  if (!support || !eff || eff === 'off') return null
  return { type: 'enabled', budget_tokens: THINK_BUDGET[eff] }
}
