import type { Provider, ProviderConfig, ProviderEvent, ProviderRequest, AssistantTurn } from './provider.js'
import { readSSE } from './sse.js'
import { normalizeUsage, emptyUsage, type NormalizedUsage } from './usage.js'

/**
 * OpenAI-compatible provider. Works with OpenAI, OpenRouter, DeepSeek, Groq,
 * Ollama (/v1), LM Studio, vLLM — anything speaking the /chat/completions dialect.
 *
 * Usage: `/chat/completions` does NOT return usage during streaming unless you
 * ask. We send `stream_options: { include_usage: true }`, which makes the
 * endpoint emit a final chunk carrying `usage`. Endpoints that ignore the flag
 * simply never send it — we then report usage as unknown, never as zero.
 */
export function openaiProvider(config: ProviderConfig): Provider {
  return {
    id: 'openai',
    async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
      const url = config.baseUrl.replace(/\/$/, '') + '/chat/completions'
      const body = {
        model: req.model || config.model,
        stream: true,
        // Ask for the usage summary on the terminal chunk (ignored by endpoints
        // that do not support it — harmless either way).
        stream_options: { include_usage: true },
        max_tokens: req.maxTokens ?? config.maxTokens ?? 8192,
        messages: [
          { role: 'system', content: req.system },
          ...req.messages.map((m) => {
            const out: Record<string, unknown> = {
              role: m.role,
              content: m.role === 'assistant' && m.toolCalls?.length && !m.content ? null : (m.content ?? ''),
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

      let response: Response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${config.apiKey}`,
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
      let usage: NormalizedUsage | null = null
      const calls = new Map<number, { id: string; name: string; arguments: string }>()

      for await (const payload of readSSE(response)) {
        let chunk: {
          choices?: Array<{
            delta?: {
              content?: string
              tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }>
            }
          }>
          usage?: {
            prompt_tokens?: number
            completion_tokens?: number
            total_tokens?: number
            prompt_tokens_details?: { cached_tokens?: number }
          }
          error?: { message?: string }
        }
        try {
          chunk = JSON.parse(payload)
        } catch {
          // A malformed chunk must not kill an otherwise usable response.
          continue
        }
        if (chunk.error) {
          yield { type: 'error', message: chunk.error.message ?? 'unknown provider error' }
          return
        }

        // The usage chunk usually arrives last and carries no choices.
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
