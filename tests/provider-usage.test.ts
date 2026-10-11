import { afterEach, describe, expect, it, vi } from 'vitest'
import { openaiProvider } from '../src/llm/openai.js'
import { anthropicProvider } from '../src/llm/anthropic.js'
import type { ProviderConfig, ProviderEvent } from '../src/llm/provider.js'

/** Build a fake SSE response from raw `data:` frames. */
function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

async function collect(providerChat: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = []
  for await (const event of providerChat) events.push(event)
  return events
}

const OPENAI_CONFIG: ProviderConfig = {
  id: 'openai',
  baseUrl: 'https://fake.example/v1',
  apiKey: 'sk-fake-key-for-tests',
  model: 'gpt-4o',
}

const ANTHROPIC_CONFIG: ProviderConfig = {
  id: 'anthropic',
  baseUrl: 'https://fake.example',
  apiKey: 'sk-ant-fake-key-for-tests',
  model: 'claude-3-5-sonnet',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openai usage extraction', () => {
  it('reads the terminal usage chunk and subtracts cached tokens from the billed input', async () => {
    let requestBody: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          `data: ${JSON.stringify({
            choices: [],
            usage: {
              prompt_tokens: 1000,
              completion_tokens: 200,
              total_tokens: 1200,
              prompt_tokens_details: { cached_tokens: 400 },
            },
          })}\n\n`,
          'data: [DONE]\n\n',
        ])
      }),
    )

    const provider = openaiProvider(OPENAI_CONFIG)
    const events = await collect(
      provider.chat({ system: 'sys', messages: [], tools: [], model: 'gpt-4o' }),
    )

    // We must ASK for usage on streaming endpoints.
    expect((requestBody['stream_options'] as { include_usage: boolean } | undefined)?.include_usage).toBe(true)

    const done = events.find((e) => e.type === 'done')
    expect(done).toBeDefined()
    if (done?.type !== 'done') throw new Error('expected done event')
    expect(done.usage.inputTokens).toBe(600) // 1000 - 400 cached, billed once
    expect(done.usage.cachedInputTokens).toBe(400)
    expect(done.usage.outputTokens).toBe(200)
    expect(done.usage.complete).toBe(true)
    expect(done.usage.source).toBe('provider')
    // The streamed text still arrives.
    expect(events.some((e) => e.type === 'text' && e.delta === 'Hello')).toBe(true)
  })

  it('a streaming endpoint that never reports usage yields UNKNOWN usage, not zero', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse(['data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n', 'data: [DONE]\n\n']),
      ),
    )
    const provider = openaiProvider(OPENAI_CONFIG)
    const events = await collect(provider.chat({ system: 's', messages: [], tools: [], model: 'gpt-4o' }))
    const done = events.find((e) => e.type === 'done')
    if (done?.type !== 'done') throw new Error('expected done event')
    expect(done.usage.inputTokens).toBeNull()
    expect(done.usage.outputTokens).toBeNull()
    expect(done.usage.complete).toBe(false)
    // The response itself is still fully usable.
    expect(events.some((e) => e.type === 'text')).toBe(true)
  })

  it('a malformed frame in the middle of the stream does not kill the response or the usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
          'data: {this is not json\n\n',
          `data: ${JSON.stringify({
            choices: [],
            usage: { prompt_tokens: 50, completion_tokens: 10 },
          })}\n\n`,
          'data: [DONE]\n\n',
        ]),
      ),
    )
    const provider = openaiProvider(OPENAI_CONFIG)
    const events = await collect(provider.chat({ system: 's', messages: [], tools: [], model: 'gpt-4o' }))
    const done = events.find((e) => e.type === 'done')
    if (done?.type !== 'done') throw new Error('expected done event')
    expect(done.result.content).toBe('par')
    expect(done.usage.inputTokens).toBe(50)
    expect(done.usage.outputTokens).toBe(10)
  })
})

describe('anthropic usage extraction', () => {
  it('takes input from message_start, output from message_delta, and keeps cache fields separate', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'event: message_start\n',
          `data: ${JSON.stringify({
            type: 'message_start',
            message: {
              usage: { input_tokens: 500, cache_read_input_tokens: 200, cache_creation_input_tokens: 100 },
            },
          })}\n\n`,
          'event: content_block_delta\n',
          `data: ${JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } })}\n\n`,
          'event: message_delta\n',
          `data: ${JSON.stringify({ type: 'message_delta', usage: { output_tokens: 80 } })}\n\n`,
          'event: message_stop\n',
          'data: {"type":"message_stop"}\n\n',
        ]),
      ),
    )
    const provider = anthropicProvider(ANTHROPIC_CONFIG)
    const events = await collect(provider.chat({ system: 's', messages: [], tools: [], model: 'claude-3-5-sonnet' }))
    const done = events.find((e) => e.type === 'done')
    if (done?.type !== 'done') throw new Error('expected done event')
    // Anthropic input_tokens are already exclusive — no subtraction.
    expect(done.usage.inputTokens).toBe(500)
    expect(done.usage.cachedInputTokens).toBe(200)
    expect(done.usage.cacheWriteTokens).toBe(100)
    expect(done.usage.outputTokens).toBe(80)
    expect(done.usage.complete).toBe(true)
  })

  it('malformed usage values become nulls instead of crashing a valid response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        sseResponse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":"abc"}}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
          'data: {"type":"message_delta","usage":{"output_tokens":5}}\n\n',
        ]),
      ),
    )
    const provider = anthropicProvider(ANTHROPIC_CONFIG)
    const events = await collect(provider.chat({ system: 's', messages: [], tools: [], model: 'claude-3-5-sonnet' }))
    const done = events.find((e) => e.type === 'done')
    if (done?.type !== 'done') throw new Error('expected done event')
    expect(done.result.content).toBe('ok')
    expect(done.usage.inputTokens).toBeNull() // "abc" rejected
    expect(done.usage.outputTokens).toBe(5) // valid part still recorded
  })

  it('an endpoint that reports no usage at all yields UNKNOWN usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseResponse(['data: {"type":"message_stop"}\n\n'])),
    )
    const provider = anthropicProvider(ANTHROPIC_CONFIG)
    const events = await collect(provider.chat({ system: 's', messages: [], tools: [], model: 'claude-3-5-sonnet' }))
    const done = events.find((e) => e.type === 'done')
    if (done?.type !== 'done') throw new Error('expected done event')
    expect(done.usage.inputTokens).toBeNull()
    expect(done.usage.outputTokens).toBeNull()
    expect(done.usage.complete).toBe(false)
  })

  it('groups multiple tool_result messages into a single user message for Anthropic API', async () => {
    let capturedBody: Record<string, unknown> = {}
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>
        return sseResponse(['data: {"type":"message_stop"}\n\n'])
      }),
    )
    const provider = anthropicProvider(ANTHROPIC_CONFIG)
    await collect(
      provider.chat({
        system: 'sys',
        messages: [
          { role: 'user', content: 'run tasks' },
          {
            role: 'assistant',
            content: '',
            toolCalls: [
              { id: 'c1', name: 'read_file', arguments: '{"path":"a"}' },
              { id: 'c2', name: 'read_file', arguments: '{"path":"b"}' },
            ],
          },
          { role: 'tool', toolCallId: 'c1', content: 'output a' },
          { role: 'tool', toolCallId: 'c2', content: 'output b' },
        ],
        tools: [],
        model: 'claude-3-5-sonnet',
      }),
    )

    const msgs = capturedBody['messages'] as Array<{ role: string; content: Array<{ type: string; tool_use_id?: string }> }>
    expect(msgs).toHaveLength(3) // user, assistant, user
    expect(msgs[0]?.role).toBe('user')
    expect(msgs[1]?.role).toBe('assistant')
    expect(msgs[2]?.role).toBe('user')
    // Both tool results must be grouped in the single terminal user message!
    expect(msgs[2]?.content).toHaveLength(2)
    expect(msgs[2]?.content[0]?.type).toBe('tool_result')
    expect(msgs[2]?.content[0]?.tool_use_id).toBe('c1')
    expect(msgs[2]?.content[1]?.type).toBe('tool_result')
    expect(msgs[2]?.content[1]?.tool_use_id).toBe('c2')
  })
})
