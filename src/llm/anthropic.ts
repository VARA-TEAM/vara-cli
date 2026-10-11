import type { Provider, ProviderConfig, ProviderEvent, ProviderRequest, AssistantTurn } from './provider.js'
import { readSSE } from './sse.js'
import { normalizeUsage, emptyUsage } from './usage.js'

interface OpenAiStyleTool {
  function?: { name: string; description?: string; parameters?: Record<string, unknown> }
}

/**
 * Anthropic Messages API provider (direct HTTP, no SDK dependency).
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

      const body = {
        model: req.model || config.model,
        stream: true,
        max_tokens: req.maxTokens ?? config.maxTokens ?? 8192,
        system: req.system,
        ...(tools.length ? { tools } : {}),
        messages: req.messages.map((m) => {
          if (m.role === 'tool') {
            return { role: 'user', content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: m.content }] }
          }
          if (m.role === 'assistant' && m.toolCalls?.length) {
            const blocks: Array<Record<string, unknown>> = []
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
            return { role: 'assistant', content: blocks }
          }
          return { role: m.role, content: m.content }
        }),
      }

      let response: Response
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
        yield { type: 'error', message: `Model request failed: ${(err as Error).message}` }
        return
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        yield { type: 'error', message: `Model error ${response.status}: ${text.slice(0, 2000)}` }
        return
      }

      let content = ''
      const calls = new Map<number, { id: string; name: string; arguments: string }>()
      // Usage is spread across the stream: input in message_start, output in
      // message_delta. Accumulate rather than overwrite so partial frames work.
      let inputTokens: number | null = null
      let cachedInputTokens: number | null = null
      let cacheWriteTokens: number | null = null
      let outputTokens: number | null = null
      let sawUsage = false

      for await (const payload of readSSE(response)) {
        let event: {
          type?: string
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
          content_block?: { type?: string; id?: string; name?: string }
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string }
          error?: { message?: string }
        }
        try {
          event = JSON.parse(payload)
        } catch {
          // A malformed frame must not kill an otherwise valid response.
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
        if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
          calls.set(calls.size, {
            id: event.content_block.id ?? `call_${calls.size}`,
            name: event.content_block.name ?? '',
            arguments: '',
          })
        }
        if (event.type === 'content_block_delta' && event.delta) {
          if (event.delta.type === 'text_delta' && event.delta.text) {
            content += event.delta.text
            yield { type: 'text', delta: event.delta.text }
          }
          if (event.delta.type === 'input_json_delta' && event.delta.partial_json) {
            const last = [...calls.entries()].pop()
            if (last) last[1].arguments += event.delta.partial_json
          }
        }
      }

      const result: AssistantTurn = {
        content,
        toolCalls: [...calls.values()].map((c) => ({
          id: c.id,
          name: c.name,
          arguments: c.arguments || '{}',
        })),
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
