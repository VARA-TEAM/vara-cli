import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { Engine } from '../src/core/engine.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { addNote, memoryBlock } from '../src/core/memory.js'

class Scripted implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly script: AssistantTurn[]) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    const turn = this.script.shift() ?? { content: 'done', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

let work: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'vara-memeng-'))
})
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

const session = () => createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'do a thing', acceptance: ['x'], cwd: work, auto: false }), DEFAULT_CONFIG)
const ask = (q = 'what next, please?'): AssistantTurn => ({ content: '', toolCalls: [{ id: 'a', name: 'ask_user', arguments: JSON.stringify({ question: q }) }] })

describe('the engine puts memory into the system prompt, within budget', () => {
  it('a note saved earlier reaches the next session\'s first request', async () => {
    addNote('project', work, 'the build command is "make all"')
    const provider = new Scripted([ask()])
    await new Engine({ session: session(), provider, memoryBlock: () => memoryBlock(work, 400) }).run()
    expect(provider.requests[0]!.system).toContain('the build command is "make all"')
  })

  it('without the option (memory off) the prompt has no memory section', async () => {
    const provider = new Scripted([ask()])
    await new Engine({ session: session(), provider }).run()
    expect(provider.requests[0]!.system).not.toContain('# Memory')
  })

  it('the injected block never exceeds the configured budget', () => {
    for (let i = 0; i < 50; i++) addNote('user', work, `user preference number ${i} ${'y'.repeat(100)}`)
    for (const budget of [50, 200, 400]) expect(Math.ceil(memoryBlock(work, budget).length / 4)).toBeLessThanOrEqual(budget + 20)
  })
})
