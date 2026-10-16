import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { SessionRunner } from '../src/core/runner.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'

class Summariser implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    yield { type: 'text', delta: 'GOAL: fix the bug. DONE: edited a.ts. OPEN: run tests.' }
    yield { type: 'done', result: { content: '', toolCalls: [] } }
  }
}

let work: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'vara-cp-'))
})
afterAll(() => rm(work, { recursive: true, force: true }))

const longSession = () => {
  const s = createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'fix the bug', acceptance: ['x'], cwd: work, auto: false }), DEFAULT_CONFIG)
  s.transcript.push({ role: 'user', content: 'fix the bug', at: new Date().toISOString() })
  for (let i = 0; i < 20; i++) {
    s.transcript.push({ role: 'user', content: `step ${i}: ` + 'detail '.repeat(40), at: new Date().toISOString() })
    s.transcript.push({ role: 'assistant', content: `done ${i}: ` + 'result '.repeat(40), at: new Date().toISOString() })
  }
  return s
}

describe('/compact', () => {
  it('folds the older conversation with the session model and honours the focus', async () => {
    const session = longSession()
    const provider = new Summariser()
    const runner = new SessionRunner(session, provider, undefined, () => {})
    const r = await runner.compact('keep the schema decisions')
    expect(r).not.toBeNull()
    expect(r).not.toBe('busy')
    expect(session.summary?.text).toContain('GOAL')
    expect(session.transcript.some((m) => m.summarized)).toBe(true)
    expect(provider.requests[0]!.messages[0]!.content).toContain('keep the schema decisions')
    // the last messages stay as they were
    expect(session.transcript.at(-1)!.summarized).toBeFalsy()
  })
  it('says there is nothing to fold in a short conversation', async () => {
    const s = createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'hi', acceptance: ['x'], cwd: work, auto: false }), DEFAULT_CONFIG)
    const runner = new SessionRunner(s, new Summariser(), undefined, () => {})
    expect(await runner.compact()).toBeNull()
  })
})
