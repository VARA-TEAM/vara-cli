import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { Engine } from '../src/core/engine.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { policyFor } from '../src/core/modes.js'

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
  work = await mkdtemp(join(tmpdir(), 'vara-modes-'))
})
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

const session = () => createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'do a thing', acceptance: ['x'], cwd: work, auto: false }), DEFAULT_CONFIG)

describe('a custom mode is enforced by the engine', () => {
  const policy = policyFor({ review: { description: 'Review only', base: 'build', allowTools: ['read_file', 'list_dir'], denyTools: [], allowCommands: [], denyCommands: [] } }, 'review')

  it('refuses a tool the mode does not allow, tells the model the limits, and hides the tool', async () => {
    const s = session()
    s.config.customMode = 'review'
    const provider = new Scripted([
      { content: '', toolCalls: [{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'nope.txt', content: 'x' }) }] },
      { content: 'ok', toolCalls: [{ id: 'c2', name: 'ask_user', arguments: JSON.stringify({ question: 'what next, please?' }) }] },
    ])
    await new Engine({ session: s, provider, modePolicy: () => policy }).run()

    expect(existsSync(join(work, 'nope.txt'))).toBe(false)
    const denied = s.transcript.find((m) => m.role === 'tool' && m.toolName === 'write_file')
    expect(denied?.content).toMatch(/Denied: Mode "review"/)
    const first = provider.requests[0]!
    expect(first.system).toMatch(/Custom mode: review/)
    const offered = (first.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(offered).toContain('read_file')
    expect(offered).not.toContain('write_file')
    expect(offered).not.toContain('shell')
  })

  it('with no policy the same call is allowed (the policy is what blocked it)', async () => {
    const s = session()
    const provider = new Scripted([
      { content: '', toolCalls: [{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'yes.txt', content: 'x' }) }] },
      { content: 'ok', toolCalls: [{ id: 'c2', name: 'ask_user', arguments: JSON.stringify({ question: 'what next, please?' }) }] },
    ])
    await new Engine({ session: s, provider }).run()
    expect(existsSync(join(work, 'yes.txt'))).toBe(true)
  })

  it('sub-agents inherit the policy', async () => {
    const s = session()
    s.config.customMode = 'review'
    const provider = new Scripted([
      { content: '', toolCalls: [{ id: 'd1', name: 'delegate', arguments: JSON.stringify({ tasks: [{ title: 'writer', kind: 'work', prompt: 'write a file called sub.txt please' }] }) }] },
      // the sub-agent's turn: tries to write
      { content: '', toolCalls: [{ id: 's1', name: 'write_file', arguments: JSON.stringify({ path: 'sub.txt', content: 'x' }) }] },
      { content: 'could not', toolCalls: [] },
      { content: 'ok', toolCalls: [{ id: 'c2', name: 'ask_user', arguments: JSON.stringify({ question: 'what next, please?' }) }] },
    ])
    const withDelegate = policyFor({ review: { description: 'Review only', base: 'build', allowTools: ['read_file', 'delegate'], denyTools: [], allowCommands: [], denyCommands: [] } }, 'review')
    await new Engine({ session: s, provider, modePolicy: () => withDelegate }).run()
    const report = s.transcript.find((m) => m.role === 'tool' && m.toolName === 'delegate')
    expect(report?.content).toMatch(/writer/) // the sub-agent really ran…
    expect(existsSync(join(work, 'sub.txt'))).toBe(false) // …and could not write
  })
})
