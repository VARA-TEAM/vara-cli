import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { contextStatus } from '../src/core/context.js'

let workdir: string
let Engine: typeof import('../src/core/engine.js').Engine
let createSession: typeof import('../src/core/session.js').createSession
let CreateSessionInput: typeof import('../src/core/session.js').CreateSessionInput
let store: typeof import('../src/core/store.js')

/** Scripted provider: each call returns the next scripted turn and records the request. */
class FakeProvider implements Provider {
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

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vara-work-'))
  store = await import('../src/core/store.js')
  const sessionModule = await import('../src/core/session.js')
  createSession = sessionModule.createSession
  CreateSessionInput = sessionModule.CreateSessionInput
  Engine = (await import('../src/core/engine.js')).Engine
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

function makeSession(over: Record<string, unknown> = {}) {
  const input = CreateSessionInput.parse({
    kind: 'task',
    mode: 'build',
    objective: 'Build a tiny thing',
    acceptance: ['it runs'],
    cwd: workdir,
    verifyCommand: 'node -e "process.exit(0)"',
    ...over,
  })
  return createSession(input, DEFAULT_CONFIG)
}

describe('engine', () => {
  it('completes a task only after independent verification passes', async () => {
    const session = makeSession()
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'hello' }) }] },
      { content: 'All conditions met.', toolCalls: [{ id: 'c2', name: 'complete', arguments: JSON.stringify({ summary: 'Built the thing', verificationPlan: 'node exit0 passed', verifiedRequirements: ['1'] }) }] },
    ])
    const engine = new Engine({ session, provider })
    await engine.run()

    expect(session.state).toBe('completed')
    expect(session.evidence.some((e) => e.kind === 'command' && e.ok)).toBe(true)
    // The write actually happened in the working directory.
    const { readFile } = await import('node:fs/promises')
    expect(await readFile(join(workdir, 'a.txt'), 'utf8')).toBe('hello')
  })

  it('forwards provider thinking to the UI, scrubs it, and keeps it out of the audit log', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(0)"' })
    // An sk- shaped secret: scrubAll's pattern layer catches this regardless of
    // which module instance registered it. (vitest isolates the static-import and
    // dynamic-import module registries, so a secret registered via the test's
    // `registerSecret` is NOT visible to engine.ts's `scrubAll` — a harness
    // artifact, not product behavior. In a real single-process run they share one
    // instance; that registered-secret path is proven by tests/redact.test.ts.)
    // This test proves the ENGINE wires `thinking` through scrubAll at all.
    const SECRET = 'sk-live-abcdefghijklmnopqrstuvwxyz'
    // A provider that streams reasoning (echoing the secret), then the answer.
    class ThinkingProvider implements Provider {
      id = 'openai' as const
      async *chat(): AsyncIterable<ProviderEvent> {
        yield { type: 'thinking', text: `I will use the key ${SECRET} to call the API` }
        yield { type: 'thinking', text: 'now writing the file' }
        yield { type: 'text', delta: 'All conditions met.' }
        yield {
          type: 'done',
          result: { content: 'All conditions met.', toolCalls: [{ id: 'c1', name: 'complete', arguments: JSON.stringify({ summary: 'done', verificationPlan: 'exit 0', verifiedRequirements: ['1'] }) }] },
        }
      }
    }

    const seen: Array<{ type: string; text?: string }> = []
    const engine = new Engine({ session, provider: new ThinkingProvider(), onEvent: (e) => seen.push({ type: e.type, ...(e.type === 'thinking' ? { text: e.text } : {}) }) })
    await engine.run()

    // 1) The engine reaches a terminal state — thinking never breaks the loop.
    expect(session.state).toBe('completed')

    // 2) Thinking is forwarded to the frontend AND the secret value never
    //    appears in it (the security guarantee that matters).
    const thinking = seen.filter((e) => e.type === 'thinking')
    expect(thinking).toHaveLength(2)
    // The slice that echoed the secret: value gone, redaction marker present.
    expect(thinking[0]?.text).not.toContain(SECRET)
    expect(thinking[0]?.text).toMatch(/⟦/)
    // Clean reasoning with no secret passes through verbatim (nothing to redact).
    expect(thinking[1]?.text).toBe('now writing the file')

    // 3) The final answer still streamed normally.
    expect(seen.some((e) => e.type === 'text')).toBe(true)

    // 4) Reasoning is NOT evidence: it must not reach the audit log.
    const log = await store.readEventLog(session.id)
    expect(log.some((e) => e['type'] === 'thinking')).toBe(false)
  })

  it('enforces the token budget when building model messages — drops oldest tool output first', () => {
    const session = makeSession({ model: 'deepseek-ai/deepseek-v4.1-flash' })
    // A transcript far larger than the model's request budget: 40 tool results
    // of ~8k chars each (~2k tokens each) = ~80k tokens, against a ~58k budget.
    for (let i = 0; i < 40; i++) {
      session.transcript.push({
        role: 'tool',
        content: `result ${i} `.repeat(1000),
        at: new Date().toISOString(),
        toolCallId: `t${i}`,
        toolName: 'shell',
      } as (typeof session.transcript)[number])
    }
    // The most recent message must survive (it carries current state).
    session.transcript.push({
      role: 'assistant',
      content: 'final answer',
      at: new Date().toISOString(),
    } as (typeof session.transcript)[number])

    const engine = new Engine({ session, provider: new FakeProvider([]) })
    const out = (engine as unknown as { toModelMessages(): Array<{ content: string; role: string }> }).toModelMessages()

    // Budget must actually be enforced, not merely approximated.
    const budget = contextStatus(session, { maxOutputTokens: DEFAULT_CONFIG.context.maxOutputTokens }).requestBudgetTokens
    const sentChars = out.reduce((n, m) => n + m.content.length, 0)
    expect(Math.ceil(sentChars / 4)).toBeLessThanOrEqual(budget)

    // The most recent message is never dropped.
    expect(out[out.length - 1]?.content).toBe('final answer')
    // The oldest tool output is replaced by a marker, not sent verbatim.
    expect(out.some((m) => m.content === '[earlier tool output trimmed to save context]')).toBe(true)
    // No verbatim oldest result leaks through.
    expect(out[0]?.content).not.toContain('result 0 ')
  })

  it('stops after repeated text-only turns instead of burning the budget on a silent loop', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(0)"' })
    // The model speaks forever but never acts: exactly the 247-turn stall the
    // real stress session exhibited. The engine must pause, not loop.
    const silent = Array.from({ length: 8 }, (_, i) => ({ content: `thinking about step ${i}…`, toolCalls: [] }))
    const engine = new Engine({ session, provider: new FakeProvider(silent) })
    await engine.run()

    expect(session.state).toBe('waiting_user')
    // It must stop WELL before the scripted 8 turns are consumed.
    expect(session.usage.turns).toBeLessThan(8)
    expect(session.stateReason).toMatch(/no actions|no progress/i)
  })

  it('a failing tool call that writes nothing must not reset the stall counter', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(0)"' })
    // Each turn calls edit_file on a nonexistent path: the tool FAILS and the
    // transcript does not grow, so the engine must still detect the stall.
    const failing = Array.from({ length: 8 }, (_, i) => ({
      content: '',
      toolCalls: [{ id: `f${i}`, name: 'edit_file', arguments: JSON.stringify({ path: 'ghost.txt', find: 'x', replace: 'y' }) }],
    }))
    const engine = new Engine({ session, provider: new FakeProvider(failing) })
    await engine.run()

    expect(session.state).toBe('waiting_user')
    expect(session.usage.turns).toBeLessThan(8)
  })

  it('rejects a claim that omits verifiedRequirements entirely — 0/0 coverage is not success', async () => {    const session = makeSession()
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'c1', name: 'complete', arguments: JSON.stringify({ summary: 'All done for real', verificationPlan: 'trust me' }) }] },
      { content: '', toolCalls: [{ id: 'c2', name: 'complete', arguments: JSON.stringify({ summary: 'Still claiming done here', verificationPlan: 'trust me' }) }] },
      { content: '', toolCalls: [{ id: 'c3', name: 'complete', arguments: JSON.stringify({ summary: 'Third time claiming done', verificationPlan: 'trust me' }) }] },
    ])
    const engine = new Engine({ session, provider })
    await engine.run()

    expect(session.state).toBe('failed')
    const failedEvidence = session.evidence.find((e) => e.kind === 'verification' && !e.ok)
    expect(failedEvidence?.output).toMatch(/does not cover/i)
  })

  it('rejects the completion claim when verification fails, then marks the session failed', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(1)"' })
    const claim = {
      content: '',
      toolCalls: [{ id: 'c1', name: 'complete', arguments: JSON.stringify({ summary: 'Trust me', verificationPlan: 'nothing', verifiedRequirements: ['1'] }) }],
    }
    const provider = new FakeProvider([claim, { ...claim }, { ...claim }])
    const engine = new Engine({ session, provider })
    await engine.run()

    expect(session.state).toBe('failed')
    expect(session.stateReason).toMatch(/verification kept failing/i)
  })

  it('injects queued follow-ups at the next turn and marks them applied', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(0)"' })
    const provider = new FakeProvider([
      { content: 'Working on it.', toolCalls: [] },
      {
        content: 'Done with the change.',
        toolCalls: [{ id: 'c9', name: 'complete', arguments: JSON.stringify({ summary: 'done', verificationPlan: 'ok', verifiedRequirements: ['1', '2'] }) }],
      },
    ])
    const engine = new Engine({ session, provider })
    engine.queueFollowUp('Use PostgreSQL instead of SQLite.')
    await engine.run()

    const firstRequest = provider.requests[0]!
    const joined = firstRequest.messages.map((m) => m.content).join('\n')
    expect(joined).toContain('Use PostgreSQL instead of SQLite.')
    const secondRequest = provider.requests[1]!
    expect(secondRequest.messages.map((m) => m.content).join('\n')).toContain('Use PostgreSQL instead of SQLite.')
    expect(session.followUps[0]!.appliedAtTurn).toBe(1)
  })

  it('rejects a completion claim that ignores a requirement added by a follow-up', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(0)"' })
    const provider = new FakeProvider([
      { content: 'Working.', toolCalls: [] },
      {
        content: 'Original objective done.',
        toolCalls: [
          {
            id: 'c1',
            name: 'complete',
            arguments: JSON.stringify({
              summary: 'greeting.txt created',
              verificationPlan: 'checked the file',
              verifiedRequirements: ['1'], // ignores the follow-up (requirement 2)
            }),
          },
        ],
      },
      {
        content: 'Now the calculator too.',
        toolCalls: [
          {
            id: 'c2',
            name: 'complete',
            arguments: JSON.stringify({
              summary: 'Both the file and the calculator are done',
              verificationPlan: 'tests pass',
              verifiedRequirements: ['1', '2'],
            }),
          },
        ],
      },
    ])
    const engine = new Engine({ session, provider })
    engine.queueFollowUp('Also build a calculator.')
    await engine.run()

    expect(session.state).toBe('completed')
    // The engine must have rejected the first claim (missing requirement 2)
    // before accepting the second one.
    expect(session.stateReason).toContain('Both the file and the calculator')
    expect(session.evidence.some((e) => e.kind === 'verification' && !e.ok)).toBe(true)
    expect(session.evidence.some((e) => e.kind === 'verification' && e.ok)).toBe(true)
    expect(session.activeRequirements).toHaveLength(2)
    expect(session.activeRequirements?.[1]).toContain('Also build a calculator')
  })

  it('pauses in waiting_user when the model asks the user something', async () => {
    const session = makeSession()
    const provider = new FakeProvider([
      {
        content: '',
        toolCalls: [{ id: 'q1', name: 'ask_user', arguments: JSON.stringify({ question: 'Which database?' }) }],
      },
    ])
    const engine = new Engine({ session, provider })
    await engine.run()

    expect(session.state).toBe('waiting_user')
    expect(session.stateReason).toContain('Which database?')
    // State must be persisted so a restart can resume it.
    const reloaded = await store.loadSession(session.id)
    expect(reloaded?.state).toBe('waiting_user')
  })

  it('refuses mutating tools in plan mode even if the model calls them', async () => {
    const session = makeSession({ mode: 'plan' })
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'w1', name: 'write_file', arguments: JSON.stringify({ path: 'evil.txt', content: 'x' }) }] },
      {
        content: 'Planning done.',
        toolCalls: [{ id: 'q2', name: 'ask_user', arguments: JSON.stringify({ question: 'Switch to build mode?' }) }],
      },
    ])
    const engine = new Engine({ session, provider })
    await engine.run()

    const { existsSync } = await import('node:fs')
    expect(existsSync(join(workdir, 'evil.txt'))).toBe(false)
    const toolReply = session.transcript.find((m) => m.role === 'tool')
    expect(toolReply?.content).toMatch(/Denied/)
  })

  it('forces a strategy change after two consecutive failures of the same tool', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(0)"' })
    // delete_file on a missing path fails twice in a row — the second failure
    // must carry the engine's strategy-change note.
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'd1', name: 'delete_file', arguments: JSON.stringify({ path: 'ghost.txt' }) }] },
      { content: '', toolCalls: [{ id: 'd2', name: 'delete_file', arguments: JSON.stringify({ path: 'ghost.txt' }) }] },
      {
        content: 'Planning done.',
        toolCalls: [{ id: 'q9', name: 'ask_user', arguments: JSON.stringify({ question: 'Blocked?' }) }],
      },
    ])
    const engine = new Engine({ session, provider })
    await engine.run()

    const toolResults = session.transcript.filter((m) => m.role === 'tool').map((m) => m.content)
    const second = toolResults.find((c) => c.includes('failed 2 times in a row'))
    expect(second).toBeDefined()
    expect(second).toContain('Do NOT retry the same call')
  })

  it('warns at 70% of the budget and still runs the honest report on exhaustion', async () => {
    const session = makeSession({ verifyCommand: 'node -e "process.exit(0)"' })
    session.config.budget = { maxTurns: 4, maxDurationMs: 60 * 60_000, maxModelCalls: 300 }
    const events: Array<{ type: string; percent?: number; reason?: string }> = []
    // Model never claims completion — the budget must run out and produce an
    // honest paused report, never a silent success.
    const provider = new FakeProvider([
      { content: 'working', toolCalls: [{ id: 'r1', name: 'read_file', arguments: JSON.stringify({ path: 'missing.txt' }) }] },
      { content: 'working', toolCalls: [{ id: 'r2', name: 'read_file', arguments: JSON.stringify({ path: 'missing.txt' }) }] },
      { content: 'working', toolCalls: [{ id: 'r3', name: 'read_file', arguments: JSON.stringify({ path: 'missing.txt' }) }] },
      { content: 'working', toolCalls: [{ id: 'r4', name: 'read_file', arguments: JSON.stringify({ path: 'missing.txt' }) }] },
    ])
    const engine = new Engine({
      session,
      provider,
      onEvent: (e) => {
        if (e.type === 'budget_warning' || e.type === 'budget_exhausted' || e.type === 'session_summary') {
          events.push({ type: e.type, percent: (e as { percent?: number }).percent, reason: (e as { reason?: string }).reason })
        }
      },
    })
    await engine.run()

    expect(session.state).toBe('paused')
    expect(session.stateReason).toMatch(/Budget exhausted/)
    // Warnings fired before exhaustion (4 turns: 75% hits at turn 3).
    expect(events.some((e) => e.type === 'budget_warning')).toBe(true)
    // The honest report is emitted on exhaustion — not a silent stop.
    expect(events.some((e) => e.type === 'session_summary')).toBe(true)
    // And the budget warning text was injected into the transcript so the
    // model saw it, not just the UI.
    expect(session.transcript.some((m) => m.content.includes('BUDGET —'))).toBe(true)
  })
})
