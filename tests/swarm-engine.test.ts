import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { Engine } from '../src/core/engine.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import type { EngineEvent } from '../src/core/types.js'

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
  work = await mkdtemp(join(tmpdir(), 'vara-swarm-'))
})
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

const session = (mode: 'plan' | 'build' = 'build') =>
  createSession(CreateSessionInput.parse({ kind: 'task', mode, objective: 'do a thing', acceptance: ['x'], cwd: work, auto: false }), DEFAULT_CONFIG)
const ask = { content: 'ok', toolCalls: [{ id: 'z', name: 'ask_user', arguments: JSON.stringify({ question: 'what next, please?' }) }] }
const delegate = (tasks: unknown[]) => ({ content: '', toolCalls: [{ id: 'd', name: 'delegate', arguments: JSON.stringify({ tasks }) }] })

describe('delegate runs a swarm', () => {
  it('orders dependent tasks, shows every agent the team plan and the earlier report, and merges the result', async () => {
    const s = session()
    const events: EngineEvent[] = []
    const provider = new Scripted([
      delegate([
        { id: 'w', title: 'write it', prompt: 'write the summary of the findings', role: 'implementer', dependsOn: ['r'] },
        { id: 'r', title: 'research', prompt: 'find the facts about the module', role: 'researcher' },
      ]),
      { content: 'FACTS: the module has three files', toolCalls: [] }, // researcher
      { content: 'WROTE: the summary', toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify({ question: 'is this what you wanted?' }) }] }, // implementer (work agents end by asking or completing)
      ask,
    ])
    await new Engine({ session: s, provider, onEvent: (e) => events.push(e) }).run()

    const merged = s.transcript.find((m) => m.toolName === 'delegate')!.content
    expect(merged).toMatch(/Swarm result: 2 done, 0 failed, 0 skipped/)
    expect(merged).toMatch(/FACTS: the module has three files/)
    expect(merged).toMatch(/WROTE: the summary/)
    expect(merged).toMatch(/check their work/) // an implementer ran: the parent is told to verify

    const researcher = provider.requests[1]!
    const implementer = provider.requests[2]!
    const text = (r: ProviderRequest) => r.messages.map((m) => m.content).join('\n')
    expect(text(researcher)).toMatch(/RESEARCHER/)
    expect(text(researcher)).toMatch(/Team plan \(you are r\)/)
    expect(text(implementer)).toMatch(/IMPLEMENTER/)
    expect(text(implementer)).toMatch(/Report of r/)
    expect(text(implementer)).toMatch(/FACTS: the module has three files/)

    const statuses = events.filter((e) => e.type === 'subagent').map((e) => (e.type === 'subagent' ? `${e.id}:${e.status}` : ''))
    expect(statuses.indexOf('r:running')).toBeLessThan(statuses.indexOf('w:running'))
    expect(statuses).toContain('w:done')
    expect(events.some((e) => e.type === 'subagent' && e.id === 'w' && e.role === 'implementer' && e.dependsOn?.[0] === 'r')).toBe(true)
  })

  it('rejects a bad plan with a reason and runs nothing', async () => {
    const s = session()
    const provider = new Scripted([delegate([{ id: 'a', title: 'one', prompt: 'do the first thing now', dependsOn: ['ghost'] }]), ask])
    await new Engine({ session: s, provider }).run()
    const r = s.transcript.find((m) => m.toolName === 'delegate')!
    expect(r.content).toMatch(/Swarm plan rejected: .*unknown task "ghost"/)
    expect(provider.requests.length).toBe(2) // no sub-agent was started
  })

  it('a plan-mode parent can only run read-only sub-agents, whatever the roles say', async () => {
    const s = session('plan')
    const provider = new Scripted([delegate([{ title: 'fix it', prompt: 'fix the bug in the module', role: 'implementer' }]), { content: 'looked', toolCalls: [] }, ask])
    await new Engine({ session: s, provider }).run()
    const names = (provider.requests[1]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).not.toContain('write_file')
  })

  it('the config can lower the call budget: later tasks are skipped, and the merged report says so', async () => {
    const s = session()
    const provider = new Scripted([
      delegate([
        { id: 'a', title: 'first', prompt: 'do the first thing now' },
        { id: 'b', title: 'second', prompt: 'do the second thing now', dependsOn: ['a'] },
      ]),
      { content: 'first done', toolCalls: [] },
      ask,
    ])
    await new Engine({ session: s, provider, swarm: () => ({ maxModelCalls: 1 }) }).run()
    const merged = s.transcript.find((m) => m.toolName === 'delegate')!.content
    expect(merged).toMatch(/1 done, 0 failed, 1 skipped/)
    expect(merged).toMatch(/budget/i)
  })
})
