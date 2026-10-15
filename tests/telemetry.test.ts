import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { normalizeUsage, type NormalizedUsage } from '../src/llm/usage.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'

let workdir: string
let Engine: typeof import('../src/core/engine.js').Engine
let createSession: typeof import('../src/core/session.js').createSession
let CreateSessionInput: typeof import('../src/core/session.js').CreateSessionInput
let store: typeof import('../src/core/store.js')

/** Scripted provider: each call gets the next step (turn + optional usage). */
interface ScriptStep {
  turn?: AssistantTurn
  usage?: NormalizedUsage
  /** When set, the call yields this error instead of a turn (a failed/retried call). */
  error?: string
}

class UsageProvider implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly script: ScriptStep[]) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    const step = this.script.shift() ?? { turn: { content: 'done', toolCalls: [] } }
    if (step.error) {
      yield { type: 'error', message: step.error }
      return
    }
    const turn = step.turn ?? { content: 'done', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn, ...(step.usage ? { usage: step.usage } : {}) }
  }
}

function makeSession(over: Record<string, unknown> = {}) {
  const input = CreateSessionInput.parse({
    kind: 'task',
    mode: 'build',
    objective: 'Build a tiny thing',
    acceptance: ['it runs'],
    cwd: workdir,
    verifyCommand: 'node -e "process.exit(0)"',
    model: 'gpt-4o', // priced in the registry — cost must be computable
    ...over,
  })
  return createSession(input, DEFAULT_CONFIG)
}

const WRITE_TURN: AssistantTurn = {
  content: '',
  toolCalls: [{ id: 'c1', name: 'write_file', arguments: JSON.stringify({ path: 't.txt', content: 'hello' }) }],
}
function completeTurn(): AssistantTurn {
  return {
    content: '',
    toolCalls: [
      {
        id: 'c2',
        name: 'complete',
        arguments: JSON.stringify({ summary: 'Built it', verificationPlan: 'exit 0', verifiedRequirements: ['1'] }),
      },
    ],
  }
}

/** gpt-4o: $2.5/1M input, $10/1M output, $1.25/1M cached. */
const CALL_1 = normalizeUsage({ totalInput: 1000, output: 100, source: 'provider' }) // $0.0035
const CALL_2 = normalizeUsage({ totalInput: 2000, cachedInput: 500, output: 300, source: 'provider' }) // $0.007375
const CALL_1_COST = (1000 / 1e6) * 2.5 + (100 / 1e6) * 10
const CALL_2_COST = (1500 / 1e6) * 2.5 + (500 / 1e6) * 1.25 + (300 / 1e6) * 10

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vara-telemetry-'))
  const sessionModule = await import('../src/core/session.js')
  createSession = sessionModule.createSession
  CreateSessionInput = sessionModule.CreateSessionInput
  Engine = (await import('../src/core/engine.js')).Engine
  store = await import('../src/core/store.js')
})

afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('per-call accounting', () => {
  it('records each model call exactly once and derives session totals from the ledger', async () => {
    const session = makeSession()
    const events: Array<{ type: string; record?: unknown }> = []
    const provider = new UsageProvider([
      { turn: WRITE_TURN, usage: CALL_1 },
      { turn: completeTurn(), usage: CALL_2 },
    ])
    const engine = new Engine({ session, provider, onEvent: (e) => events.push(e) })
    await engine.run()

    expect(session.state).toBe('completed')
    expect(session.modelCalls).toHaveLength(2)
    expect(session.modelCalls![0]!.costUsd).toBeCloseTo(CALL_1_COST, 10)
    expect(session.modelCalls![1]!.costUsd).toBeCloseTo(CALL_2_COST, 10)
    expect(session.modelCalls![1]!.cachedInputTokens).toBe(500)

    // Totals derived from the ledger, not accumulated blindly.
    expect(session.usage.inputTokens).toBe(2500) // (1000-0) + (2000-500)
    expect(session.usage.outputTokens).toBe(400)
    expect(session.usage.cachedInputTokens).toBe(500)
    expect(session.usage.costUsd).toBeCloseTo(CALL_1_COST + CALL_2_COST, 10)
    expect(session.usage.costPartial).toBe(false)
    expect(session.usage.unpricedCalls).toBe(0)

    // Every call surfaced as a model_usage event for live display.
    const usageEvents = events.filter((e) => e.type === 'model_usage')
    expect(usageEvents).toHaveLength(2)
  })

  it('a failed call is recorded as UNKNOWN usage (not zero), and a retry is priced separately', async () => {
    const session = makeSession()
    // Attempt 1 fails at the provider → paused, one unpriced ledger entry.
    const failing = new UsageProvider([{ error: 'Model error 500: upstream exploded' }])
    await new Engine({ session, provider: failing }).run()

    expect(session.state).toBe('paused')
    expect(session.modelCalls).toHaveLength(1)
    expect(session.modelCalls![0]!.inputTokens).toBeNull()
    expect(session.modelCalls![0]!.costUsd).toBeNull()
    expect(session.modelCalls![0]!.costNote).toMatch(/provider error/i)
    expect(session.usage.costUsd).toBeNull() // unknown, NOT $0.00
    expect(session.usage.unpricedCalls).toBe(1)

    // Retry: a fresh engine on the same session completes the task.
    const retry = new UsageProvider([
      { turn: WRITE_TURN, usage: CALL_1 },
      { turn: completeTurn(), usage: CALL_2 },
    ])
    await new Engine({ session, provider: retry }).run()

    expect(session.state).toBe('completed')
    // 1 failed + 2 successful = 3 ledger entries, each exactly once.
    expect(session.modelCalls).toHaveLength(3)
    expect(session.usage.unpricedCalls).toBe(1)
    expect(session.usage.costPartial).toBe(true)
    expect(session.usage.costUsd).toBeCloseTo(CALL_1_COST + CALL_2_COST, 10)
  })

  it('a provider that reports no usage keeps the session cost unknown, never zero', async () => {
    const session = makeSession()
    const provider = new UsageProvider([{ turn: WRITE_TURN }, { turn: completeTurn() }])
    await new Engine({ session, provider }).run()

    expect(session.state).toBe('completed')
    expect(session.modelCalls).toHaveLength(2)
    expect(session.usage.inputTokens).toBeNull()
    expect(session.usage.costUsd).toBeNull()
    expect(session.usage.unpricedCalls).toBe(2)
    expect(session.usage.costPartial).toBe(true)
  })
})

describe('save / resume', () => {
  it('loading a session recomputes totals from the ledger without duplicating cost', async () => {
    const session = makeSession()
    const provider = new UsageProvider([
      { turn: WRITE_TURN, usage: CALL_1 },
      { turn: completeTurn(), usage: CALL_2 },
    ])
    await new Engine({ session, provider }).run()

    const loaded = await store.loadSession(session.id)
    expect(loaded).not.toBeNull()
    expect(loaded!.modelCalls).toHaveLength(2)
    expect(loaded!.usage.costUsd).toBeCloseTo(CALL_1_COST + CALL_2_COST, 10)
    expect(loaded!.usage.inputTokens).toBe(2500)
    // Load again — idempotent, still no duplication.
    const again = await store.loadSession(session.id)
    expect(again!.usage.costUsd).toBeCloseTo(CALL_1_COST + CALL_2_COST, 10)
  })

  it('resuming a paused session appends to the ledger and totals stay exact', async () => {
    const session = makeSession()
    await new Engine({ session, provider: new UsageProvider([{ error: 'boom' }]) }).run()

    // Save already happened inside run(); reload through the store like a real resume.
    const resumed = await store.loadSession(session.id)
    expect(resumed).not.toBeNull()
    expect(resumed!.modelCalls).toHaveLength(1)

    const retry = new UsageProvider([
      { turn: WRITE_TURN, usage: CALL_1 },
      { turn: completeTurn(), usage: CALL_2 },
    ])
    await new Engine({ session: resumed!, provider: retry }).run()

    expect(resumed!.modelCalls).toHaveLength(3)
    expect(resumed!.usage.costUsd).toBeCloseTo(CALL_1_COST + CALL_2_COST, 10)
    const final = await store.loadSession(session.id)
    expect(final!.usage.costUsd).toBeCloseTo(CALL_1_COST + CALL_2_COST, 10)
  })

  it('writes model_usage records into the append-only event log (audit trail)', async () => {
    const session = makeSession()
    const provider = new UsageProvider([
      { turn: WRITE_TURN, usage: CALL_1 },
      { turn: completeTurn(), usage: CALL_2 },
    ])
    await new Engine({ session, provider }).run()

    const log = await store.readEventLog(session.id)
    const usageRecords = log.filter((e) => e['type'] === 'model_usage')
    expect(usageRecords).toHaveLength(2)
    // Text deltas stay out of the audit log (they live in the transcript).
    expect(log.some((e) => e['type'] === 'text')).toBe(false)
  })
})

describe('backward compatibility', () => {
  it('a session persisted before cost accounting loads with UNKNOWN cost fields, not zeros', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises')
    const { sessionDir, sessionStateFile } = await import('../src/config/paths.js')
    const id = 'legacy01'
    await mkdir(sessionDir(id), { recursive: true })
    const legacy = {
      id,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      state: 'completed',
      config: {
        kind: 'task',
        mode: 'build',
        objective: 'an old objective',
        acceptance: [],
        budget: { maxTurns: 5, maxDurationMs: 60000, maxModelCalls: 10 },
        cwd: workdir,
        model: 'some-old-model',
        allowPublish: false,
      },
      transcript: [],
      followUps: [],
      evidence: [],
      // Old Usage shape: no token/cost fields, no modelCalls ledger.
      usage: { turns: 3, modelCalls: 5, toolCalls: 2, startedAt: new Date().toISOString(), elapsedMs: 1000 },
      lastProgressTurn: 3,
    }
    await writeFile(sessionStateFile(id), JSON.stringify(legacy), 'utf8')

    const loaded = await store.loadSession(id)
    expect(loaded).not.toBeNull()
    expect(loaded!.usage.inputTokens).toBeNull()
    expect(loaded!.usage.costUsd).toBeNull()
    // 5 historical model calls exist but nothing is known about them.
    expect(loaded!.usage.unpricedCalls).toBe(5)
    expect(loaded!.usage.costPartial).toBe(true)
    expect(loaded!.modelCalls).toEqual([])
  })
})

describe('telemetry hygiene', () => {
  it('records contain only whitelisted fields — no keys, no prompts, no secrets', async () => {
    const session = makeSession()
    const provider = new UsageProvider([
      { turn: WRITE_TURN, usage: CALL_1 },
      { turn: completeTurn(), usage: CALL_2 },
    ])
    await new Engine({ session, provider }).run()

    const allowed = new Set([
      'at', 'model', 'providerId', 'turn', 'inputTokens', 'outputTokens',
      'cachedInputTokens', 'cacheWriteTokens', 'usageSource', 'costUsd',
      'costPartial', 'costNote',
      // cost engine v2: router tier/phase and the savings baseline (plain numbers and enum words)
      'tier', 'phase', 'baselineInputTokens',
    ])
    for (const record of session.modelCalls!) {
      for (const key of Object.keys(record)) expect(allowed.has(key)).toBe(true)
    }
    const serialized = JSON.stringify(session.modelCalls)
    expect(serialized).not.toMatch(/apiKey|authorization|sk-/i)
  })

  it('cost notes carrying provider errors are scrubbed of credential shapes', async () => {
    const session = makeSession()
    const provider = new UsageProvider([{ error: 'Model error 401: invalid key sk-abcdefghijklmnopqrstuv' }])
    await new Engine({ session, provider }).run()

    const note = session.modelCalls![0]!.costNote ?? ''
    expect(note).toContain('⟦api-key⟧')
    expect(note).not.toContain('sk-abcdefghijklmnopqrstuv')
  })
})
