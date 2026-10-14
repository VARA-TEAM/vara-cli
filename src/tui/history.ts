import type { Session, TranscriptMessage } from '../core/types.js'
import type { Entry } from './entries.js'

/**
 * Pure transcript logic for the TUI: rebuilding history when a session is
 * resumed, and collapsing repetitive notes so the view never floods.
 *
 * Keeping this out of the React components makes the behavior unit-testable —
 * the "12 identical mode notes" class of bug lives here, not in JSX.
 */

/** Hard cap on replayed entries so a 500-turn session cannot freeze the TUI. */
export const REPLAY_LIMIT = 150

/**
 * Append an entry with collapsing rules:
 *
 *   1. A note whose text is identical to the immediately previous note is
 *      dropped (pure duplicate).
 *   2. A note carrying a `group` REPLACES the previous entry when that entry
 *      has the same group — e.g. toggling PLAN/BUILD updates one line instead
 *      of stacking twelve.
 *   3. Everything else appends; the list is capped at `cap` (oldest dropped).
 */
export function appendEntry(prev: Entry[], entry: Entry, cap = 300): Entry[] {
  const last = prev[prev.length - 1]
  if (last && entry.kind === 'note' && last.kind === 'note') {
    if (entry.group && last.group === entry.group) {
      return [...prev.slice(0, -1), entry]
    }
    if (!entry.group && !last.group && last.text === entry.text) {
      return prev
    }
  }
  const next = [...prev, entry]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/**
 * Rebuild the visible transcript from a persisted session.
 *
 * A resumed session must show what happened — a 60-turn run whose history
 * vanishes on restart is unusable. The engine's transcript is the source:
 *
 *   - assistant text           → assistant entries
 *   - user text                → user entries
 *   - assistant tool calls     → tool entries (pending marker; output filled
 *                                in from the matching tool result when found)
 *   - tool results             → attached to their tool entry, not shown twice
 *
 * Older tool results (>30 messages from the end) were trimmed by the engine to
 * save context; replay mirrors that so the view matches what the model sees.
 */
export function replayTranscript(session: Session, limit = REPLAY_LIMIT): Entry[] {
  const messages = session.transcript.slice(-limit)
  const outputById = new Map<string, string>()
  for (const m of messages) {
    if (m.role === 'tool' && m.toolCallId) outputById.set(m.toolCallId, m.content)
  }

  const entries: Entry[] = []
  // The engine trims tool outputs older than 30 messages; mirror that.
  const trimBefore = Math.max(0, messages.length - 30)

  messages.forEach((m: TranscriptMessage, i) => {
    if (m.role === 'user') {
      // Engine-injected control messages are not something the user said.
      if (/^\[(ENGINE|SYSTEM|BUDGET|FOLLOW-UP INSTRUCTION)/.test(m.content)) return
      entries.push({ kind: 'user', text: m.content })
      return
    }
    if (m.role === 'assistant') {
      if (m.content.trim()) entries.push({ kind: 'assistant', text: m.content })
      for (const call of m.toolCalls ?? []) {
        const trimmed = i < trimBefore
        entries.push({
          kind: 'tool',
          id: call.id,
          name: call.name,
          args: call.arguments,
          // Output of trimmed tool results is intentionally gone — do not
          // pretend to know the outcome of a call the engine itself dropped.
          ...(trimmed || !outputById.has(call.id) ? {} : { output: outputById.get(call.id) }),
        })
      }
      return
    }
    // role 'system' — engine instructions; not conversation, skip.
  })

  return entries
}

/** The one-line "resumed" banner shown above a replayed transcript. */
export function resumeBanner(session: Session): Entry {
  return {
    kind: 'note',
    group: 'resume-banner',
    color: 'cyan',
    text:
      `resumed session ${session.id} — ${session.usage.turns} turns · ` +
      `${session.usage.toolCalls} tool calls · ${session.state}`,
  }
}
