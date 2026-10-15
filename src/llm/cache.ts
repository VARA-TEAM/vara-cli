/**
 * Anthropic cache-breakpoint placement.
 *
 * A request may carry up to 4 `cache_control` breakpoints. VARA uses:
 *   1. the last tool definition        (tools are the most stable part)
 *   2. the system prompt
 *   3. the last block of the PREVIOUS user-role message
 *   4. the last block of the LAST message
 *
 * Why 3: cache entries are written only at breakpoints, and a read looks back at
 * most 20 positions from each breakpoint for an entry an earlier request wrote
 * (consecutive tool_use blocks, or consecutive tool_result blocks, count as ONE
 * position - Anthropic's prompt-caching docs). Breakpoint 3 sits exactly where
 * the previous request's breakpoint 4 was, so it is a guaranteed hit however
 * many positions the turn added. For an ordinary tool turn (text + tool_use
 * group + tool_result group = 3 positions) this changes nothing - the benchmark
 * shows identical cache share - so it is insurance for turns that add 20+
 * separate blocks (many images or attachments), not a saving in the common case.
 */

export type AnthropicMessage = { role: 'user' | 'assistant'; content: unknown }

const CACHE = { type: 'ephemeral' as const }

function mark(msg: AnthropicMessage): void {
  if (typeof msg.content === 'string') {
    if (msg.content) msg.content = [{ type: 'text', text: msg.content, cache_control: CACHE }]
  } else if (Array.isArray(msg.content) && msg.content.length) {
    ;(msg.content[msg.content.length - 1] as Record<string, unknown>)['cache_control'] = CACHE
  }
}

/** Mark the last message and the user message before the latest assistant turn. Mutates `messages`. */
export function placeMessageBreakpoints(messages: AnthropicMessage[]): number {
  if (!messages.length) return 0
  let placed = 0
  const last = messages.length - 1
  mark(messages[last]!)
  placed++
  // The previous user-role message: skip the last message and the assistant turn before it.
  for (let i = last - 1; i >= 0; i--) {
    if (messages[i]!.role === 'user') {
      mark(messages[i]!)
      placed++
      break
    }
  }
  return placed
}
