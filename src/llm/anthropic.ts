import type { Provider, ProviderConfig, ProviderEvent, ProviderRequest, AssistantTurn } from './provider.js'
import { readSSE } from './sse.js'
import { anthropicThinking } from './capabilities.js'
import { normalizeUsage, emptyUsage } from './usage.js'
import { isRetryable, retryDelay, parseRetryAfter, sleep } from './retry.js'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

interface OpenAiStyleTool {
  function?: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/**
 * Anthropic Messages API provider (direct HTTP, no SDK dependency).
 *
 * Features:
 *   - Streaming with proper SSE parsing
 *   - Strict alternating user/assistant message compliance
 *   - Extended thinking support (thinking content blocks)
 *   - Retry with exponential backoff on 429/500/502/503/529
 *   - Proper cache token accounting (separate from regular input)
 *   - Robust error handling with actionable messages
 *
 * Usage semantics differ from OpenAI:
 *   - input tokens arrive in `message_start`  (message.usage.input_tokens)
 *   - output tokens arrive in `message_delta` (usage.output_tokens)
 *   - cache usage uses dedicated fields:
 *       cache_read_input_tokens      (served from cache — cheap)
 *       cache_creation_input_tokens  (written to cache — expensive)
 *   `input_tokens` there EXCLUDES both cache counts, so nothing is double-billed.
 */
export function anthropicProvider(config: ProviderConfig): Provider {
  return {
    id: 'anthropic',
    async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const url = config.baseUrl.replace(/\/$/, '') + '/v1/messages'
      const tools = (req.tools as OpenAiStyleTool[])
        .filter((t) => t.function?.name)
        .map((t) => ({
          name: t.function!.name,
          description: t.function!.description ?? '',
          input_schema: t.function!.parameters ?? { type: 'object', properties: {} },
        }))

      const thinking = req.thinking !== undefined ? anthropicThinking({ type: 'anthropic', baseUrl: config.baseUrl, model: req.model || config.model }, req.thinking) : null

      // Anthropic requires strictly alternating user/assistant messages and groups
      // all tool_result blocks following an assistant tool_use message into ONE user message.
      const anthropicMessages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
      for (const m of req.messages) {
        if (m.role === 'tool') {
          const toolBlock = {
            type: 'tool_result',
            tool_use_id: m.toolCallId || 'unknown_call',
            content: m.content || '(empty output)',
          }
          const prev = anthropicMessages[anthropicMessages.length - 1]
          if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
            prev.content.push(toolBlock)
          } else if (prev && prev.role === 'user' && typeof prev.content === 'string') {
            prev.content = [{ type: 'text', text: prev.content }, toolBlock]
          } else {
            anthropicMessages.push({ role: 'user', content: [toolBlock] })
          }
          continue
        }

        if (m.role === 'assistant' && m.toolCalls?.length) {
          const blocks: Array<Record<string, unknown>> = []
          // Extended thinking: the signed blocks of a tool turn must be replayed first.
          if (thinking && m.reasoning?.length) blocks.push(...(m.reasoning as Array<Record<string, unknown>>))
          if (m.content) blocks.push({ type: 'text', text: m.content })
          for (const call of m.toolCalls) {
            let input: unknown = {}
            try {
              input = JSON.parse(call.arguments || '{}')
            } catch {
              input = {}
            }
            blocks.push({ type: 'tool_use', id: call.id, name: call.name, input })
          }
          const prev = anthropicMessages[anthropicMessages.length - 1]
          if (prev && prev.role === 'assistant') {
            if (Array.isArray(prev.content)) {
              prev.content.push(...blocks)
            } else {
              prev.content = [{ type: 'text', text: String(prev.content) }, ...blocks]
            }
          } else {
            anthropicMessages.push({ role: 'assistant', content: blocks })
          }
          continue
        }

        if (m.role === 'user' && m.images?.length) {
          const blocks: Array<Record<string, unknown>> = [
            ...m.images.map((i) => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })),
            { type: 'text', text: m.content || '(see the attached images)' },
          ]
          const prev = anthropicMessages[anthropicMessages.length - 1]
          if (prev && prev.role === 'user') {
            prev.content = Array.isArray(prev.content) ? [...prev.content, ...blocks] : [{ type: 'text', text: String(prev.content) }, ...blocks]
          } else {
            anthropicMessages.push({ role: 'user', content: blocks })
          }
          continue
        }

        if (m.role === 'user') {
          const prev = anthropicMessages[anthropicMessages.length - 1]
          if (prev && prev.role === 'user') {
            if (typeof prev.content === 'string') {
              prev.content = `${prev.content}\n\n${m.content}`
            } else if (Array.isArray(prev.content)) {
              prev.content.push({ type: 'text', text: m.content })
            }
            continue
          }
          anthropicMessages.push({ role: 'user', content: m.content })
          continue
        }

        if (m.role === 'assistant') {
          const prev = anthropicMessages[anthropicMessages.length - 1]
          if (prev && prev.role === 'assistant') {
            if (typeof prev.content === 'string') {
              prev.content = `${prev.content}\n\n${m.content}`
            } else if (Array.isArray(prev.content)) {
              prev.content.push({ type: 'text', text: m.content })
            }
            continue
          }
          anthropicMessages.push({ role: 'assistant', content: m.content })
        }
      }

      // Anthropic requires the first message to be 'user' — inject a placeholder if needed
      if (anthropicMessages.length > 0 && anthropicMessages[0]!.role !== 'user') {
        anthropicMessages.unshift({ role: 'user', content: 'Begin working on the objective described in your instructions.' })
      }

      // Prompt caching: the system prompt, the tool list and the conversation so
      // far are re-sent every turn. Marking them cacheable makes the repeats
      // cost ~10% of the normal input price.
      const cache = { type: 'ephemeral' as const }
      if (tools.length) (tools[tools.length - 1] as Record<string, unknown>)['cache_control'] = cache
      const lastMsg = anthropicMessages[anthropicMessages.length - 1]
      if (lastMsg) {
        if (typeof lastMsg.content === 'string') lastMsg.content = [{ type: 'text', text: lastMsg.content, cache_control: cache }]
        else if (Array.isArray(lastMsg.content) && lastMsg.content.length) {
          ;(lastMsg.content[lastMsg.content.length - 1] as Record<string, unknown>)['cache_control'] = cache
        }
      }
      const maxTokens = req.maxTokens ?? config.maxTokens ?? 8192
      const body: Record<string, unknown> = {
        model: req.model || config.model,
        stream: true,
        // Thinking tokens count against max_tokens: leave room for the answer.
        max_tokens: thinking ? Math.max(maxTokens, thinking.budget_tokens + 4096) : maxTokens,
        system: [{ type: 'text', text: req.system, cache_control: cache }],
        ...(thinking ? { thinking } : {}),
        ...(tools.length ? { tools } : {}),
        messages: anthropicMessages,
      }

      // Retry loop with exponential backoff
      let response: Response | null = null
      let lastError = ''

      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          response = await fetch(url, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-api-key': config.apiKey,
              'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify(body),
            signal: req.signal,
          })
        } catch (err) {
          if (req.signal?.aborted) {
            yield { type: 'error', message: 'Request cancelled.' }
            return
          }
          lastError = (err as Error).message
          if (attempt < MAX_RETRIES) {
            const delay = retryDelay(attempt, { baseDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS })
            try { await sleep(delay, req.signal) } catch { break }
            continue
          }
          yield { type: 'error', message: `Model request failed after ${MAX_RETRIES + 1} attempts: ${lastError}` }
          return
        }

        if (response.ok) break

        const status = response.status
        const text = await response.text().catch(() => '')

        if (isRetryable(status) && attempt < MAX_RETRIES) {
          const retryAfter = parseRetryAfter(response)
          const delay = retryAfter ?? retryDelay(attempt, { baseDelayMs: BASE_DELAY_MS, maxDelayMs: MAX_DELAY_MS })
          lastError = `${status}: ${text.slice(0, 500)}`
          try { await sleep(delay, req.signal) } catch { break }
          continue
        }

        const errorMsg = parseAnthropicError(status, text)
        yield { type: 'error', message: errorMsg }
        return
      }

      if (!response || !response.ok) {
        yield { type: 'error', message: `Model request failed: ${lastError || 'unknown error'}` }
        return
      }

      let content = ''
      let thinkingContent = ''
      // Signed reasoning blocks to replay with the tool turn.
      const reasoning: Array<Record<string, unknown>> = []
      let openReasoning: Record<string, unknown> | null = null
      const calls = new Map<number, { id: string; name: string; arguments: string }>()
      let inputTokens: number | null = null
      let cachedInputTokens: number | null = null
      let cacheWriteTokens: number | null = null
      let outputTokens: number | null = null
      let sawUsage = false
      // Track current content block type for routing deltas
      let currentBlockType = ''

      for await (const payload of readSSE(response)) {
        let event: {
          type?: string
          index?: number
          message?: {
            usage?: {
              input_tokens?: number
              cache_read_input_tokens?: number
              cache_creation_input_tokens?: number
            }
          }
          usage?: {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number
            cache_creation_input_tokens?: number
          }
          content_block?: { type?: string; id?: string; name?: string; text?: string; thinking?: string; data?: string }
          delta?: { type?: string; text?: string; thinking?: string; signature?: string; partial_json?: string; stop_reason?: string }
          error?: { message?: string; type?: string }
        }
        try {
          event = JSON.parse(payload)
        } catch {
          continue
        }

        if (event.type === 'error') {
          yield { type: 'error', message: event.error?.message ?? 'unknown provider error' }
          return
        }
        if (event.type === 'message_start' && event.message?.usage) {
          sawUsage = true
          inputTokens = event.message.usage.input_tokens ?? inputTokens
          cachedInputTokens = event.message.usage.cache_read_input_tokens ?? cachedInputTokens
          cacheWriteTokens = event.message.usage.cache_creation_input_tokens ?? cacheWriteTokens
        }
        if (event.type === 'message_delta' && event.usage) {
          sawUsage = true
          if (event.usage.input_tokens !== undefined) inputTokens = event.usage.input_tokens
          if (event.usage.cache_read_input_tokens !== undefined) cachedInputTokens = event.usage.cache_read_input_tokens
          if (event.usage.cache_creation_input_tokens !== undefined)
            cacheWriteTokens = event.usage.cache_creation_input_tokens
          if (event.usage.output_tokens !== undefined) outputTokens = event.usage.output_tokens
        }

        // Content block tracking
        if (event.type === 'content_block_start') {
          currentBlockType = event.content_block?.type ?? ''

          if (currentBlockType === 'tool_use') {
            calls.set(calls.size, {
              id: event.content_block?.id ?? `call_${calls.size}`,
              name: event.content_block?.name ?? '',
              arguments: '',
            })
          }
          if (currentBlockType === 'thinking') openReasoning = { type: 'thinking', thinking: event.content_block?.thinking ?? '', signature: '' }
          if (currentBlockType === 'redacted_thinking') reasoning.push({ type: 'redacted_thinking', data: event.content_block?.data ?? '' })
          // Extended thinking block start
          if (currentBlockType === 'thinking' && event.content_block?.thinking) {
            thinkingContent += event.content_block.thinking
            yield { type: 'thinking', text: event.content_block.thinking }
          }
        }

        if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta' && event.delta.text) {
            content += event.delta.text
            yield { type: 'text', delta: event.delta.text }
          }
          if (event.delta.type === 'signature_delta' && event.delta.signature && openReasoning) {
            openReasoning['signature'] = String(openReasoning['signature'] ?? '') + event.delta.signature
          }
          if (event.delta.type === 'thinking_delta' && event.delta.thinking) {
            if (openReasoning) openReasoning['thinking'] = String(openReasoning['thinking'] ?? '') + event.delta.thinking
            thinkingContent += event.delta.thinking
            yield { type: 'thinking', text: event.delta.thinking }
          }
          if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            const last = [...calls.entries()].pop()
            if (last) last[1].arguments += event.delta.partial_json
          }
        }

        if (event.type === 'content_block_stop') {
          if (openReasoning) {
            reasoning.push(openReasoning)
            openReasoning = null
          }
          currentBlockType = ''
        }
      }

      const result: AssistantTurn = {
        content,
        toolCalls: [...calls.values()].map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments || '{}',
        })),
        ...(reasoning.length ? { reasoning } : {}),
      }
      const usage = sawUsage
        ? normalizeUsage({
            input: inputTokens,
            cachedInput: cachedInputTokens,
            cacheWrite: cacheWriteTokens,
            output: outputTokens,
            source: 'provider',
          })
        : emptyUsage('provider')
      yield { type: 'done', result, usage }
    },
  }
}

/** Parse an Anthropic error response into a human-readable message. */
function parseAnthropicError(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string } }
    if (parsed.error?.message) {
      const type = parsed.error.type ? ` (${parsed.error.type})` : ''
      return `Model error ${status}${type}: ${parsed.error.message}`
    }
  } catch { /* not JSON */ }

  const statusMessages: Record<number, string> = {
    400: 'Bad request — check model name and message format',
    401: 'Invalid API key — check your x-api-key configuration',
    403: 'Access denied — your API key may lack permissions',
    404: 'Model not found — check the model name',
    429: 'Rate limited — too many requests',
    500: 'Internal server error at Anthropic',
    529: 'Anthropic is overloaded — try again later',
  }
  const hint = statusMessages[status] ?? 'unexpected error'
  return `Model error ${status}: ${hint}. ${body.slice(0, 500)}`
}
