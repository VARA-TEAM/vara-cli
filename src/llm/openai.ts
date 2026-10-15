import type { Provider, ProviderConfig, ProviderEvent, ProviderRequest, AssistantTurn } from './provider.js'
import { readSSE } from './sse.js'
import { openaiThinkingParams } from './capabilities.js'
import { normalizeUsage, emptyUsage, type NormalizedUsage } from './usage.js'
import { isRetryable, retryDelay, parseRetryAfter, sleep } from './retry.js'

const MAX_RETRIES = 3
const BASE_DELAY_MS = 1000
const MAX_DELAY_MS = 30_000

/**
 * OpenAI-compatible provider. Works with OpenAI, OpenRouter, DeepSeek, Groq,
 * Ollama (/v1), LM Studio, vLLM — anything speaking the /chat/completions dialect.
 *
 * Features:
 *   - Streaming with `stream_options: { include_usage: true }`
 *   - Retry with exponential backoff on 429/500/502/503
 *   - Reasoning/thinking token support (o1/o3/o4 models)
 *   - Robust SSE parsing that tolerates malformed chunks
 */
export function openaiProvider(config: ProviderConfig): Provider {
  return {
    id: 'openai',
    async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const url = config.baseUrl.replace(/\/$/, '') + '/chat/completions'
      const modelId = (req.model || config.model).toLowerCase()

      // Reasoning models (o1, o3, o4) use developer messages instead of system
      // messages, and don't support certain parameters.
      const isReasoningModel = /\b(o1|o3|o4)(-|$)/i.test(modelId)

      const systemMessage = isReasoningModel
        ? { role: 'developer', content: req.system }
        : { role: 'system', content: req.system }

      const body: Record<string, unknown> = {
        model: req.model || config.model,
        stream: true,
        stream_options: { include_usage: true },
        messages: [
          systemMessage,
          ...req.messages.map((m) => {
            const out: Record<string, unknown> = {
              role: m.role,
              content: m.role === 'assistant' && m.toolCalls?.length && !m.content ? null : (m.content ?? ''),
            }
            if (m.role === 'user' && m.images?.length) {
              out['content'] = [
                { type: 'text', text: m.content || '(see the attached images)' },
                ...m.images.map((i) => ({ type: 'image_url', image_url: { url: `data:${i.mime};base64,${i.data}` } })),
              ]
            }
            if (m.toolCalls?.length) {
              out['tool_calls'] = m.toolCalls.map((c, i) => ({
                id: c.id || `call_${i}`,
                type: 'function',
                function: { name: c.name, arguments: c.arguments },
              }))
            }
            if (m.role === 'tool') {
              out['tool_call_id'] = m.toolCallId || 'unknown_call'
            }
            return out
          }),
        ],
        ...(req.tools.length ? { tools: req.tools } : {}),
      }

      // Reasoning models don't support max_tokens — they use max_completion_tokens
      if (isReasoningModel) {
        body['max_completion_tokens'] = req.maxTokens ?? config.maxTokens ?? 16384
      } else {
        body['max_tokens'] = req.maxTokens ?? config.maxTokens ?? 8192
      }

      // Thinking effort: only when the caller chose one AND this model is known to take it.
      if (req.thinking !== undefined) {
        Object.assign(body, openaiThinkingParams({ type: 'openai', baseUrl: config.baseUrl, model: modelId }, req.thinking))
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
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
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

        // Parse structured error message from the response
        const errorMsg = parseErrorMessage(status, text)
        yield { type: 'error', message: errorMsg }
        return
      }

      if (!response || !response.ok) {
        yield { type: 'error', message: `Model request failed: ${lastError || 'unknown error'}` }
        return
      }

      let content = ''
      let reasoningContent = ''
      let usage: NormalizedUsage | null = null
      const calls = new Map<number, { id: string; name: string; arguments: string }>()

      for await (const payload of readSSE(response)) {
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string
              reasoning_content?: string
              tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
            }
          }>
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            total_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
            completion_tokens_details?: { reasoning_tokens?: number }
          }
          error?: { message?: string; type?: string }
        }
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        if (chunk.error) {
          yield { type: 'error', message: chunk.error.message ?? 'unknown provider error' }
          return
        }

        if (chunk.usage) {
          usage = normalizeUsage({
            totalInput: chunk.usage.prompt_tokens,
            cachedInput: chunk.usage.prompt_tokens_details?.cached_tokens,
            output: chunk.usage.completion_tokens,
            source: 'provider',
          })
        }

        const choice = chunk.choices?.[0]
        if (!choice) continue
        const delta = choice.delta

        // Handle reasoning/thinking tokens (o1, o3, o4 models)
        if (delta?.reasoning_content) {
          reasoningContent += delta.reasoning_content
          yield { type: 'thinking', text: delta.reasoning_content }
        }

        if (delta?.content) {
          content += delta.content
          yield { type: 'text', delta: delta.content }
        }
        for (const tc of delta?.tool_calls ?? []) {
          const existing = calls.get(tc.index) ?? { id: tc.id ?? `call_${tc.index}`, name: '', arguments: '' }
          if (tc.id) existing.id = tc.id
          if (tc.function?.name) existing.name += tc.function.name
          if (tc.function?.arguments) existing.arguments += tc.function.arguments
          calls.set(tc.index, existing)
        }
      }

      const result: AssistantTurn = {
        content,
        toolCalls: [...calls.values()]
          .filter((c) => c.name)
          .map((c) => ({ id: c.id, name: c.name, arguments: c.arguments || '{}' })),
      }
      yield { type: 'done', result, usage: usage ?? emptyUsage('provider') }
    },
  }
}

/** Parse a provider error response into a human-readable message. */
function parseErrorMessage(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; type?: string; code?: string } }
    if (parsed.error?.message) {
      const type = parsed.error.type ? ` (${parsed.error.type})` : ''
      return `Model error ${status}${type}: ${parsed.error.message}`
    }
  } catch { /* not JSON */ }

  const statusMessages: Record<number, string> = {
    400: 'Bad request — check model name and parameters',
    401: 'Invalid API key — check your configuration',
    403: 'Access denied — your API key may lack permissions for this model',
    404: 'Model not found — check the model name in your configuration',
    429: 'Rate limited — too many requests, try again later',
    500: 'Internal server error at the provider',
    502: 'Bad gateway — the provider may be temporarily unavailable',
    503: 'Service unavailable — the provider is overloaded',
  }
  const hint = statusMessages[status] ?? 'unexpected error'
  return `Model error ${status}: ${hint}. ${body.slice(0, 500)}`
}
