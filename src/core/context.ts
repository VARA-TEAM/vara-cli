import type { Session } from './types.js'

/**
 * Context accounting — Milestone 1 foundation.
 *
 * Three separate concepts, kept apart on purpose:
 *   1. context window  — total tokens the model accepts per request
 *   2. request budget  — window minus reserved output minus safety margin
 *   3. used tokens     — rough estimate of what we would send today
 *
 * Token counts here are APPROXIMATE (chars/4 heuristic). The UI must always
 * mark them with "~". We never claim detection we did not perform: the
 * `source` field says where the window number came from.
 */

export interface ContextSettings {
  /** User override. Wins over everything when set. */
  windowTokens?: number
  /** Where `windowTokens` came from; defaults to 'configured' (set by hand). */
  windowOrigin?: ContextSource
  /** Reserve for the model's answer; never spend it on history. */
  maxOutputTokens: number
}

export type ContextSource = 'configured' | 'detected' | 'fallback'

export interface ContextStatus {
  windowTokens: number
  source: ContextSource
  maxOutputTokens: number
  /** Tokens available for instructions + history + tool output. */
  requestBudgetTokens: number
}

/** Safety margin kept out of the request budget for prompt overhead. */
const SAFETY_MARGIN_TOKENS = 2_000

/**
 * High-confidence context-window registry. Only entries we are sure about;
 * unknown models must fall through to the marked fallback — we never invent
 * a number and call it detected.
 */
const KNOWN_WINDOWS: Array<{ pattern: RegExp; windowTokens: number }> = [
  { pattern: /gpt-4\.1/i, windowTokens: 1_000_000 },
  { pattern: /gpt-4o-mini/i, windowTokens: 128_000 },
  { pattern: /gpt-4o/i, windowTokens: 128_000 },
  { pattern: /gpt-4-turbo/i, windowTokens: 128_000 },
  { pattern: /\bo[134](-|$)/i, windowTokens: 200_000 },
  { pattern: /claude/i, windowTokens: 200_000 },
  { pattern: /gemini-(1\.5|2)/i, windowTokens: 1_000_000 },
  { pattern: /deepseek-(chat|v3|reasoner|r1)/i, windowTokens: 64_000 },
  { pattern: /llama-3\.[123]/i, windowTokens: 128_000 },
  { pattern: /mistral-(large|medium|small)/i, windowTokens: 128_000 },
  { pattern: /command-r/i, windowTokens: 128_000 },
]

const FALLBACK_WINDOW_TOKENS = 64_000

/** Rough token estimate: ~4 chars per token. Always displayed as "~N". */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/** Window from the built-in pattern table alone, or null when the model is unknown. */
export function contextWindowFromPattern(model: string): number | null {
  for (const entry of KNOWN_WINDOWS) if (entry.pattern.test(model)) return entry.windowTokens
  return null
}

/** Resolve the context window for a model: user override → registry → marked fallback. */
export function resolveWindow(model: string, settings: ContextSettings): {
  windowTokens: number
  source: ContextSource
} {
  if (settings.windowTokens && settings.windowTokens > 0) {
    return { windowTokens: settings.windowTokens, source: settings.windowOrigin ?? 'configured' }
  }
  for (const entry of KNOWN_WINDOWS) {
    if (entry.pattern.test(model)) {
      return { windowTokens: entry.windowTokens, source: 'detected' }
    }
  }
  return { windowTokens: FALLBACK_WINDOW_TOKENS, source: 'fallback' }
}

/** Everything needed to display and enforce context usage for a session. */
export function contextStatus(session: Session, settings: ContextSettings): ContextStatus {
  const { windowTokens, source } = resolveWindow(session.config.model ?? '', settings)
  return {
    windowTokens,
    source,
    maxOutputTokens: settings.maxOutputTokens,
    requestBudgetTokens: Math.max(0, windowTokens - settings.maxOutputTokens - SAFETY_MARGIN_TOKENS),
  }
}

/** Rough count of the tokens a request for this session would carry. */
export function estimateSessionTokens(session: Session): number {
  let chars = session.config.objective.length
  for (const r of session.activeRequirements ?? []) chars += r.length
  for (const m of session.transcript) chars += m.content.length
  // Tool definitions and system prompt overhead (rough).
  chars += 2_000
  return Math.ceil(chars / 4)
}

export function formatTokens(n: number): string {
  return n >= 1_000 ? `${Math.round(n / 1000)}k` : String(n)
}
