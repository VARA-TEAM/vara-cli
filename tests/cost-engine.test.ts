import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { EngineEvent } from '../src/core/types.js'
import { anthropicThinking, effectiveLevel, nextLevel, openaiThinkingParams, thinkingSupport } from '../src/llm/capabilities.js'
import { anthropicProvider } from '../src/llm/anthropic.js'
import { openaiProvider } from '../src/llm/openai.js'

let workdir: string
let Engine: typeof import('../src/core/engine.js').Engine
let createSession: typeof import('../src/core/session.js').createSession
let CreateSessionInput: typeof import('../src/core/session.js').CreateSessionInput

class FakeProvider implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly script: AssistantTurn[], private readonly respond?: (req: ProviderRequest) => AssistantTurn | undefined) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })) as ProviderRequest)
    const turn = this.respond?.(req) ?? this.script.shift() ?? { content: 'ok', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

const ask = (id: string, q = 'Anything else?'): AssistantTurn => ({
  content: '',
  toolCalls: [{ id, name: 'ask_user', arguments: JSON.stringify({ question: q }) }],
})

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vara-cost-'))
  const sm = await import('../src/core/session.js')
  createSession = sm.createSession
  CreateSessionInput = sm.CreateSessionInput
  Engine = (await import('../src/core/engine.js')).Engine
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

const session = (objective: string, over: Record<string, unknown> = {}) =>
  createSession(CreateSessionInput.parse({ objective, cwd: workdir, kind: 'task', ...over }), DEFAULT_CONFIG)

describe('cost engine — compaction', () => {
  it('shrinks old tool output in one batch, keeps the recent messages intact, and records the saving', async () => {
    const s = session('inspect the logs')
    const big = 'x'.repeat(12_000)
    s.transcript.push({ role: 'user', content: 'inspect the logs', at: 't' })
    for (let i = 0; i < 12; i++) {
      s.transcript.push({ role: 'assistant', content: '', toolCalls: [{ id: `t${i}`, name: 'read_file', arguments: '{}' }], at: 't' })
      s.transcript.push({ role: 'tool', content: `[OK] ${big}`, toolCallId: `t${i}`, toolName: 'read_file', at: 't' })
    }
    const p = new FakeProvider([ask('a1')])
    await new Engine({ session: s, provider: p }).run()
    const sent = p.requests[0]!.messages.filter((m) => m.role === 'tool')
    expect(sent[0]!.content).toContain('removed to save cost')
    expect(sent[0]!.content.length).toBeLessThan(1_000)
    // The newest tool results are untouched.
    expect(sent[sent.length - 1]!.content.length).toBeGreaterThan(9_000)
    expect(s.savings!.compactedChars).toBeGreaterThan(30_000)
    // The saved transcript says so, and records the real size.
    const compacted = s.transcript.filter((m) => m.compacted)
    expect(compacted.length).toBeGreaterThan(0)
    expect(compacted[0]!.fullLength).toBeGreaterThan(10_000)
  })

  it('does nothing while the conversation is small', async () => {
    const s = session('say something')
    s.transcript.push({ role: 'user', content: 'say something', at: 't' })
    s.transcript.push({ role: 'assistant', content: '', toolCalls: [{ id: 'z', name: 'read_file', arguments: '{}' }], at: 't' })
    s.transcript.push({ role: 'tool', content: `[OK] ${'y'.repeat(5_000)}`, toolCallId: 'z', toolName: 'read_file', at: 't' })
    await new Engine({ session: s, provider: new FakeProvider([ask('a')]) }).run()
    expect(s.transcript.some((m) => m.compacted)).toBe(false)
  })
})

describe('cost engine — read dedupe', () => {
  it('answers a repeated full read of an unchanged file from context, and re-reads after a change', async () => {
    await writeFile(join(workdir, 'notes.txt'), 'hello world\n')
    const s = session('read the notes twice')
    const read = (id: string): AssistantTurn => ({ content: '', toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path: 'notes.txt' }) }] })
    const p = new FakeProvider([read('r1'), read('r2'), ask('done')])
    await new Engine({ session: s, provider: p }).run()
    const results = s.transcript.filter((m) => m.role === 'tool')
    expect(results[0]!.content).toContain('hello world')
    expect(results[1]!.content).toMatch(/unchanged since you read it/)
    expect(s.savings!.dedupedReads).toBe(1)

    // Changed on disk → read for real.
    const s2 = session('read, edit, read')
    await writeFile(join(workdir, 'b.txt'), 'one\n')
    const rb = (id: string): AssistantTurn => ({ content: '', toolCalls: [{ id, name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) }] })
    let calls = 0
    const p2 = new FakeProvider([], () => {
      calls++
      if (calls === 1) return rb('x1')
      if (calls === 2) {
        // Make the mtime differ for certain.
        return { content: '', toolCalls: [{ id: 'x2', name: 'write_file', arguments: JSON.stringify({ path: 'b.txt', content: 'two two\n' }) }] }
      }
      if (calls === 3) return rb('x3')
      return ask('end')
    })
    await new Engine({ session: s2, provider: p2 }).run()
    const outs = s2.transcript.filter((m) => m.role === 'tool' && m.toolCallId === 'x3')
    expect(outs[0]!.content).toContain('two two')
  })
})

describe('cost engine — routing and stable prefix', () => {
  it('chat and questions use the cheap model; work keeps the session model', async () => {
    const chat = session('hello there', { auto: true })
    const p = new FakeProvider([{ content: 'Hi!', toolCalls: [] }])
    await new Engine({ session: chat, provider: p, model: 'big-model', routeModel: () => 'cheap-model' }).run()
    expect(p.requests[0]!.model).toBe('cheap-model')
    expect(chat.savings!.cheapCalls).toBe(1)
    expect(chat.modelCalls![0]!.model).toBe('cheap-model')

    const work = session('create a file named a.txt', { auto: true })
    const p2 = new FakeProvider([ask('q')])
    await new Engine({ session: work, provider: p2, model: 'big-model', routeModel: () => 'cheap-model' }).run()
    expect(p2.requests[0]!.model).toBe('big-model')
  })

  it('the system prompt is identical between turns (cache-friendly); the changing state rides at the end', async () => {
    const s = session('create a file named c.txt')
    const p = new FakeProvider([
      { content: '', toolCalls: [{ id: 'w', name: 'write_file', arguments: JSON.stringify({ path: 'c.txt', content: 'x' }) }] },
      ask('end'),
    ])
    await new Engine({ session: s, provider: p }).run()
    expect(p.requests).toHaveLength(2)
    expect(p.requests[0]!.system).toBe(p.requests[1]!.system)
    expect(p.requests[0]!.messages.at(-1)!.content).toMatch(/^\[STATE\].*turn 1\//)
    expect(p.requests[1]!.messages.at(-1)!.content).toMatch(/^\[STATE\].*turn 2\//)
  })

  it('thinking level is sent on work turns only, and only when the caller supplies one', async () => {
    const work = session('create a file named d.txt')
    const p = new FakeProvider([ask('q')])
    await new Engine({ session: work, provider: p, thinkingLevel: () => 'high' }).run()
    expect(p.requests[0]!.thinking).toBe('high')

    const chat = session('hello', { auto: true })
    const p2 = new FakeProvider([{ content: 'Hi', toolCalls: [] }])
    await new Engine({ session: chat, provider: p2, thinkingLevel: () => 'high' }).run()
    expect(p2.requests[0]!.thinking).toBeUndefined()
  })
})

describe('sub-agents', () => {
  it('runs tasks in parallel with fresh context, returns their reports, and bills the parent', async () => {
    const parent = session('research the code base in depth')
    const events: EngineEvent[] = []
    let parentCalls = 0
    const provider = new FakeProvider([], (req) => {
      if (req.system.includes('You are a sub-agent')) {
        const goal = req.messages[0]!.content
        return { content: `report for ${goal.slice(0, 12)}: found things`, toolCalls: [] }
      }
      parentCalls++
      if (parentCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: 'd1',
              name: 'delegate',
              arguments: JSON.stringify({
                tasks: [
                  { title: 'Auth', prompt: 'AUTH: look at the auth module and report how login works' },
                  { title: 'DB', prompt: 'DB: look at the database layer and report the schema' },
                ],
              }),
            },
          ],
        }
      }
      return ask('end')
    })
    await new Engine({ session: parent, provider, onEvent: (e) => events.push(e) }).run()
    const out = parent.transcript.find((m) => m.role === 'tool' && m.toolName === 'delegate')!.content
    expect(out).toContain('### Auth — done')
    expect(out).toContain('report for AUTH: look')
    expect(out).toContain('### DB — done')
    // Fresh context: a sub-agent sees only its own prompt.
    const childReq = provider.requests.find((r) => r.system.includes('You are a sub-agent'))!
    expect(childReq.messages[0]!.content).toMatch(/^(AUTH|DB):/)
    expect(childReq.messages.some((m) => m.content.includes('research the code base'))).toBe(false)
    // A sub-agent cannot delegate, and explore agents are read-only.
    const names = childReq.tools.map((t) => (t as { function: { name: string } }).function.name)
    expect(names).not.toContain('delegate')
    expect(names).not.toContain('write_file')
    // Accounting and visibility.
    expect(parent.savings!.subagents).toBe(2)
    expect(parent.modelCalls!.length).toBe(2 + 2) // two parent turns + two children
    expect(events.filter((e) => e.type === 'subagent' && e.status === 'done')).toHaveLength(2)
  })

  it('a sub-agent session is never persisted', async () => {
    const store = await import('../src/core/store.js')
    const before = (await store.listSessions()).length
    const parent = session('delegate once please')
    let n = 0
    const provider = new FakeProvider([], (req) => {
      if (req.system.includes('You are a sub-agent')) return { content: 'done', toolCalls: [] }
      n++
      return n === 1
        ? { content: '', toolCalls: [{ id: 'd', name: 'delegate', arguments: JSON.stringify({ tasks: [{ title: 'T', prompt: 'look at something specific' }] }) }] }
        : ask('end')
    })
    await new Engine({ session: parent, provider }).run()
    const after = (await store.listSessions()).length
    // Only the parent may have been saved.
    expect(after - before).toBeLessThanOrEqual(1)
  })
})

describe('thinking capabilities', () => {
  const ref = (type: 'openai' | 'anthropic', baseUrl: string, model: string) => ({ type, baseUrl, model })

  it('detects support per model and endpoint — unknown models report none', () => {
    expect(thinkingSupport(ref('openai', 'https://api.openai.com/v1', 'o3-mini'))?.levels).toEqual(['low', 'medium', 'high'])
    expect(thinkingSupport(ref('openai', 'https://api.openai.com/v1', 'gpt-5'))?.mechanism).toBe('effort')
    expect(thinkingSupport(ref('openai', 'https://api.openai.com/v1', 'gpt-4o'))).toBeNull()
    expect(thinkingSupport(ref('anthropic', 'https://api.anthropic.com', 'claude-sonnet-4-5'))?.mechanism).toBe('budget')
    expect(thinkingSupport(ref('anthropic', 'https://api.anthropic.com', 'claude-3-5-haiku'))).toBeNull()
    expect(thinkingSupport(ref('openai', 'https://openrouter.ai/api/v1', 'deepseek/deepseek-r1'))?.mechanism).toBe('openrouter')
    expect(thinkingSupport(ref('openai', 'https://openrouter.ai/api/v1', 'meta/llama-3'))).toBeNull()
    expect(thinkingSupport({ ...ref('openai', 'https://openrouter.ai/api/v1', 'x/unknown'), reasoningHint: true })).not.toBeNull()
    expect(thinkingSupport(ref('openai', 'https://my-proxy.example/v1', 'anthropic/claude-sonnet-4-5'))).toBeNull()
  })

  it('maps levels to provider parameters and never sends unknown ones', () => {
    expect(openaiThinkingParams(ref('openai', 'https://api.openai.com/v1', 'o3'), 'high')).toEqual({ reasoning_effort: 'high' })
    expect(openaiThinkingParams(ref('openai', 'https://api.openai.com/v1', 'gpt-4o'), 'high')).toEqual({})
    expect(openaiThinkingParams(ref('openai', 'https://openrouter.ai/api/v1', 'openai/o3'), 'medium')).toEqual({ reasoning: { effort: 'medium' } })
    expect(anthropicThinking(ref('anthropic', 'https://api.anthropic.com', 'claude-opus-4-1'), 'medium')).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(anthropicThinking(ref('anthropic', 'https://api.anthropic.com', 'claude-opus-4-1'), 'off')).toBeNull()
    expect(anthropicThinking(ref('anthropic', 'https://api.anthropic.com', 'claude-3-5-haiku'), 'high')).toBeNull()
  })

  it('cycles through the levels the model actually has', () => {
    const sup = thinkingSupport(ref('openai', 'https://api.openai.com/v1', 'o3'))!
    expect(effectiveLevel(sup, undefined)).toBe('medium')
    expect(nextLevel(sup, 'medium')).toBe('high')
    expect(nextLevel(sup, 'high')).toBe('low')
    expect(effectiveLevel(sup, 'off')).toBe('medium') // not offered → default
  })
})

describe('providers — wire format', () => {
  const sse = (events: unknown[]) =>
    new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + 'data: [DONE]\n\n', { status: 200 })

  it('Anthropic: marks system, tools and the conversation cacheable; enables thinking; replays signed blocks', async () => {
    const bodies: Array<Record<string, any>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return sse([
          { type: 'message_start', message: { usage: { input_tokens: 5 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name: 'read_file' } },
          { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } },
          { type: 'content_block_stop', index: 1 },
          { type: 'message_delta', usage: { output_tokens: 3 } },
        ])
      }),
    )
    const provider = anthropicProvider({ id: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'claude-sonnet-4-5' })
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'd', parameters: { type: 'object', properties: {} } } }]
    let turn: AssistantTurn | undefined
    for await (const e of provider.chat({ system: 'SYS', messages: [{ role: 'user', content: 'go' }], tools, model: 'claude-sonnet-4-5', thinking: 'medium' })) {
      if (e.type === 'done') turn = e.result
    }
    const b = bodies[0]!
    expect(b['system'][0]).toMatchObject({ type: 'text', text: 'SYS', cache_control: { type: 'ephemeral' } })
    expect(b['tools'][0].cache_control).toEqual({ type: 'ephemeral' })
    expect(b['messages'][0].content[0].cache_control).toEqual({ type: 'ephemeral' })
    expect(b['thinking']).toEqual({ type: 'enabled', budget_tokens: 8192 })
    expect(b['max_tokens']).toBeGreaterThan(8192)
    // The signed block comes back with the result…
    expect(turn!.reasoning).toEqual([{ type: 'thinking', thinking: 'hmm', signature: 'SIG' }])
    // …and is replayed first on the next request.
    await (async () => {
      for await (const _ of provider.chat({
        system: 'SYS',
        messages: [
          { role: 'user', content: 'go' },
          { role: 'assistant', content: '', toolCalls: turn!.toolCalls, reasoning: turn!.reasoning },
          { role: 'tool', content: '[OK] x', toolCallId: 'tu1' },
        ],
        tools,
        model: 'claude-sonnet-4-5',
        thinking: 'medium',
      })) {
        /* drain */
      }
    })()
    expect(bodies[1]!['messages'][1].content[0]).toEqual({ type: 'thinking', thinking: 'hmm', signature: 'SIG' })
    // Without thinking: no thinking field, no replayed blocks.
    for await (const _ of provider.chat({ system: 'S', messages: [{ role: 'user', content: 'go' }], tools, model: 'claude-sonnet-4-5' })) {
      /* drain */
    }
    expect(bodies[2]!['thinking']).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('OpenAI-compatible: sends reasoning_effort only for models known to take it', async () => {
    const bodies: Array<Record<string, any>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return sse([{ choices: [{ delta: { content: 'ok' } }] }])
      }),
    )
    const run = async (model: string, thinking?: 'low' | 'high') => {
      const p = openaiProvider({ id: 'openai', baseUrl: 'https://api.openai.com/v1', apiKey: 'k', model })
      for await (const _ of p.chat({ system: 's', messages: [{ role: 'user', content: 'x' }], tools: [], model, ...(thinking ? { thinking } : {}) })) {
        /* drain */
      }
    }
    await run('o3', 'high')
    await run('gpt-4o', 'high')
    await run('o3')
    expect(bodies[0]!['reasoning_effort']).toBe('high')
    expect(bodies[1]!['reasoning_effort']).toBeUndefined()
    expect(bodies[2]!['reasoning_effort']).toBeUndefined()
    vi.unstubAllGlobals()
  })
})
