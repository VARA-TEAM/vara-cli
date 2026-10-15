import type { TranscriptMessage } from './types.js'
import { estimateTokens } from './context.js'

/**
 * Folding old turns into a summary (ROADMAP R5).
 *
 * Compaction shortens old tool output but keeps every message; after many turns
 * even the shortened history is long, and it is re-sent on every call. A summary
 * written ONCE by a cheap model replaces it for every later call. The original
 * messages are never deleted — they are marked `summarized`, so the interfaces
 * keep the full history and the audit log is untouched.
 *
 * Safety: the cut never separates an assistant message from its tool results
 * (providers reject orphans), and it is made in one batch so the cached prefix
 * is stable again right after.
 */

export interface SummaryPlan {
  /** Messages [from, to) are folded. */
  from: number
  to: number
  /** Estimated tokens of what is folded (what every later call no longer carries). */
  tokens: number
}

/** Rough size of a message as the model sees it. */
function weight(m: TranscriptMessage): number {
  return estimateTokens(m.content) + (m.toolCalls ?? []).reduce((n, c) => n + estimateTokens(c.arguments) + 10, 0)
}

export function planSummary(
  msgs: readonly TranscriptMessage[],
  opts: { keepRecent: number; minTokens: number },
): SummaryPlan | null {
  // Index 0 is the objective: always kept. Already-summarized messages are skipped (their gist is in the old summary).
  const from = 1
  let to = msgs.length - opts.keepRecent
  // Cut only before a message that is not a tool result.
  while (to > from && msgs[to]?.role === 'tool') to--
  if (to <= from) return null
  let tokens = 0
  for (let i = from; i < to; i++) if (!msgs[i]!.summarized) tokens += weight(msgs[i]!)
  if (tokens < opts.minTokens) return null
  return { from, to, tokens }
}

/** The compact transcript handed to the summariser (tool output is clipped hard). */
export function renderForSummary(msgs: readonly TranscriptMessage[], plan: SummaryPlan, previous?: string): string {
  const parts: string[] = []
  if (previous) parts.push(`PREVIOUS SUMMARY (already covers earlier work):\n${previous}`)
  for (let i = plan.from; i < plan.to; i++) {
    const m = msgs[i]!
    if (m.summarized && previous) continue
    if (m.role === 'user') parts.push(`USER: ${m.content.slice(0, 1200)}`)
    else if (m.role === 'assistant') {
      const calls = (m.toolCalls ?? []).map((c) => `${c.name}(${c.arguments.slice(0, 160)})`).join('; ')
      parts.push(`AGENT: ${m.content.slice(0, 600)}${calls ? ` [calls: ${calls}]` : ''}`)
    } else if (m.role === 'tool') parts.push(`RESULT ${m.toolName ?? ''}: ${m.content.slice(0, 500)}`)
    else parts.push(`NOTE: ${m.content.slice(0, 300)}`)
  }
  return parts.join('\n')
}

export const SUMMARY_SYSTEM = `You compress the working history of a coding agent so it can continue without it. Write a faithful, compact brief (at most 350 words) with these sections, omitting empty ones:
GOAL — what the user wants, in one or two lines (and every instruction that still applies).
DONE — what was changed or found, with file paths and line numbers.
DECISIONS — choices made and why, constraints discovered.
OPEN — what is unfinished, failing, or still to verify (include the exact failing command/error text if any).
FACTS — names, paths, commands, versions the agent will need again.
Never invent anything. Do not address the agent; just state the facts.`

/** The message that stands in for the folded history (stable text: part of the cached prefix). */
export function summaryMessage(text: string): string {
  return `[SUMMARY OF EARLIER WORK — the older messages were folded into this brief to save cost; the facts below are what they established]\n${text.trim()}`
}
