import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import type { NormalizedUsage } from '../src/llm/usage.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { EngineEvent } from '../src/core/types.js'
import { DEFAULT_ROUTER, type RouterSettings } from '../src/core/router.js'
import { DEFAULT_LIMITS, UsageMeter, type UsageRecord } from '../src/core/usage-meter.js'

let workdir: string
let Engine: typeof import('../src/core/engine.js').Engine
let createSession: typeof import('../src/core/session.js').createSession
let CreateSessionInput: typeof import('../src/core/session.js').CreateSessionInput

class Fake implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(
    private readonly script: AssistantTurn[],
    private readonly respond?: (req: ProviderRequest) => AssistantTurn | undefined,
    private readonly usage?: (req: ProviderRequest) => NormalizedUsage,
  ) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })) as ProviderRequest)
    const turn = this.respond?.(req) ?? this.script.shift() ?? { content: 'ok', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn, ...(this.usage ? { usage: this.usage(req) } : {}) }
  }
}

const call = (id: string, name: string, args: unknown = {}): AssistantTurn => ({ content: '', toolCalls: [{ id, name, arguments: JSON.stringify(args) }] })
const ask = (id: string): AssistantTurn => call(id, 'ask_user', { question: 'Anything else?' })
const usageOf = (input: number, output: number, cached: number | null = null): NormalizedUsage => ({
  inputTokens: input,
  outputTokens: output,
  cachedInputTokens: cached,
  cacheWriteTokens: null,
  reportedTotalInputTokens: input,
  source: 'provider',
  complete: true,
})

const COST = { summarize: true, toolOutputChars: 3000, smartRead: true }
const tiers = { strong: { model: 'big' }, standard: { model: 'mid' }, cheap: { model: 'small' } }
const router = (over: Partial<RouterSettings> = {}) => (): RouterSettings => ({ ...DEFAULT_ROUTER, tiers, ...over })

beforeAll(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'vara-cost2-'))
  const sm = await import('../src/core/session.js')
  createSession = sm.createSession
  CreateSessionInput = sm.CreateSessionInput
  Engine = (await import('../src/core/engine.js')).Engine
})
afterAll(async () => {
  await rm(workdir, { recursive: true, force: true })
})

const session = (objective: string, over: Record<string, unknown> = {}) =>
  createSession(CreateSessionInput.parse({ objective, cwd: workdir, kind: 'task', model: 'big', ...over }), DEFAULT_CONFIG)

describe('cost v2 - the router in the engine', () => {
  it('conversation goes to the cheap model, work to the standard one, each with a visible reason', async () => {
    const events: EngineEvent[] = []
    const chat = session('hello', { auto: true, kind: 'task' })
    const p1 = new Fake([{ content: 'hi!', toolCalls: [] }])
    await new Engine({ session: chat, provider: p1, model: 'big', router: router(), onEvent: (e) => events.push(e) }).run()
    expect(p1.requests[0]!.model).toBe('small')
    expect(chat.routing!.calls.cheap).toBe(1)

    const work = session('fix the bug in parser.ts', { auto: false })
    const p2 = new Fake([ask('a')])
    const ev2: EngineEvent[] = []
    await new Engine({ session: work, provider: p2, model: 'big', router: router(), onEvent: (e) => ev2.push(e) }).run()
    expect(p2.requests[0]!.model).toBe('mid')
    const route = ev2.find((e) => e.type === 'route')
    expect(route).toMatchObject({ type: 'route', tier: 'standard', model: 'mid', phase: 'plan' })
    expect((route as { reason: string }).reason).toContain('planning')
    expect(work.modelCalls![0]).toMatchObject({ tier: 'standard', phase: 'plan' })
  })

  it('a refused completion escalates the NEXT turn to the strong tier, and the floor is never undercut', async () => {
    const s = session('make the build pass', { auto: false, verifyCommand: 'node -e "process.exit(1)"' })
    const complete = (id: string): AssistantTurn => call(id, 'complete', { summary: 'done', verificationPlan: 'ran it', verifiedRequirements: ['1'] })
    const p = new Fake([complete('c1'), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', router: router(), costSettings: () => COST }).run()
    expect(p.requests[0]!.model).toBe('mid')
    expect(p.requests[1]!.model).toBe('big')
    expect(s.routing!.escalations).toBe(1)
    expect(s.modelCalls![1]).toMatchObject({ tier: 'strong', phase: 'verify' })
  })

  it('router settings can raise the floor: nothing in a work turn falls below it', async () => {
    const s = session('add a feature', { auto: false })
    const p = new Fake([call('r1', 'list_dir', {}), call('r2', 'list_dir', { path: '.' }), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', router: router({ floor: 'strong' }) }).run()
    for (const r of p.requests) expect(r.model).toBe('big')
  })

  it('with no router and no cost settings the engine behaves like v0.4.0 (session model for work)', async () => {
    const s = session('add a feature', { auto: false })
    const p = new Fake([ask('a')])
    await new Engine({ session: s, provider: p, model: 'big' }).run()
    expect(p.requests[0]!.model).toBe('big')
  })

  it('a tier on an unreachable provider falls back to the session model and says why', async () => {
    const events: EngineEvent[] = []
    const s = session('hello', { auto: true })
    const p = new Fake([{ content: 'hi', toolCalls: [] }])
    await new Engine({
      session: s,
      provider: p,
      model: 'big',
      router: router({ tiers: { ...tiers, cheap: { model: 'gpt-mini', provider: 'elsewhere' } } }),
      onEvent: (e) => events.push(e),
    }).run()
    expect(p.requests[0]!.model).toBe('big')
    expect((events.find((e) => e.type === 'route') as { reason: string }).reason).toContain('not available')
  })
})

describe('cost v2 - waste control', () => {
  it('stops a runaway loop after 5 identical calls and tells the user why', async () => {
    const s = session('inspect forever', { auto: false })
    const same = () => call(`l${Math.random()}`, 'list_dir', { path: '.' })
    const p = new Fake([], () => same())
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    expect(s.state).toBe('waiting_user')
    expect(s.stateReason).toContain('identical arguments 5 times')
    expect(p.requests.length).toBe(5)
    expect(s.savings!.loopStops).toBe(1)
  })

  it('skips re-running the verification command when nothing changed since its last run', async () => {
    const marker = join(workdir, 'verify-count.txt')
    await writeFile(marker, '')
    const cmd = `node -e "require('fs').appendFileSync(process.argv[1],'x');process.exit(1)" "${marker.replace(/\\/g, '/')}"`
    const s = session('make it pass', { auto: false, verifyCommand: cmd })
    const complete = (id: string): AssistantTurn => call(id, 'complete', { summary: 'done', verificationPlan: 'p', verifiedRequirements: ['1'] })
    const p = new Fake([complete('c1'), complete('c2'), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    const { readFile } = await import('node:fs/promises')
    expect((await readFile(marker, 'utf8')).length).toBe(1) // ran once
    expect(s.savings!.skippedVerifications).toBe(1)
    expect(s.evidence.some((e) => e.output?.includes('result reused'))).toBe(true)
  })

  it('re-runs verification after a tool that can change files succeeded', async () => {
    const marker = join(workdir, 'verify-count2.txt')
    await writeFile(marker, '')
    const cmd = `node -e "require('fs').appendFileSync(process.argv[1],'x');process.exit(1)" "${marker.replace(/\\/g, '/')}"`
    const s = session('make it pass', { auto: false, verifyCommand: cmd })
    const complete = (id: string): AssistantTurn => call(id, 'complete', { summary: 'done', verificationPlan: 'p', verifiedRequirements: ['1'] })
    const p = new Fake([complete('c1'), call('w1', 'write_file', { path: 'touched.txt', content: 'x' }), complete('c2'), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    const { readFile } = await import('node:fs/promises')
    expect((await readFile(marker, 'utf8')).length).toBe(2)
    expect(s.savings?.skippedVerifications ?? 0).toBe(0)
  })

  it('runs several read-only calls of one turn and keeps their results in call order', async () => {
    await writeFile(join(workdir, 'a.txt'), 'AAA\n')
    await writeFile(join(workdir, 'b.txt'), 'BBB\n')
    const s = session('read both', { auto: false })
    const two: AssistantTurn = {
      content: '',
      toolCalls: [
        { id: 'p1', name: 'read_file', arguments: JSON.stringify({ path: 'a.txt' }) },
        { id: 'p2', name: 'read_file', arguments: JSON.stringify({ path: 'b.txt' }) },
        { id: 'p3', name: 'list_dir', arguments: '{}' },
      ],
    }
    const p = new Fake([two, ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    const results = s.transcript.filter((m) => m.role === 'tool')
    expect(results.map((m) => m.toolCallId)).toEqual(['p1', 'p2', 'p3', 'a'])
    expect(results[0]!.content).toContain('AAA')
    expect(results[1]!.content).toContain('BBB')
  })

  it('still refuses a denied read in a parallel batch (permissions run first)', async () => {
    const s = session('read outside', { auto: false })
    const two: AssistantTurn = {
      content: '',
      toolCalls: [
        { id: 'q1', name: 'read_file', arguments: JSON.stringify({ path: '../../etc/passwd' }) },
        { id: 'q2', name: 'list_dir', arguments: '{}' },
      ],
    }
    const p = new Fake([two, ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    const first = s.transcript.find((m) => m.toolCallId === 'q1')!
    expect(first.content).toMatch(/FAIL/)
    expect(first.content).toMatch(/escapes the working directory|Denied/)
  })
})

describe('cost v2 - tool output economics', () => {
  const noisy = `node -e "for(let i=0;i<3000;i++)console.log(i===1500?'ERROR the thing broke at 1500':'ok line '+i)"`

  it('compresses a long command output, keeps the error line, and the model can ask for more', async () => {
    const s = session('run it', { auto: false })
    const p = new Fake([call('sh1', 'shell', { command: noisy }), call('more1', 'tool_output', { id: 'sh1', grep: 'ok line 2999' }), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    const shell = s.transcript.find((m) => m.toolCallId === 'sh1')!
    expect(shell.content.length).toBeLessThan(3600)
    expect(shell.content).toContain('ERROR the thing broke at 1500')
    expect(shell.content).toContain('tool_output')
    expect(shell.fullLength).toBeGreaterThan(10_000)
    const more = s.transcript.find((m) => m.toolCallId === 'more1')!
    expect(more.content).toContain('ok line 2999')
    expect(s.savings!.compressedChars).toBeGreaterThan(20_000)
  })

  it('without cost settings the old 12 000 character cut still applies', async () => {
    const s = session('run it', { auto: false })
    const p = new Fake([call('sh1', 'shell', { command: noisy }), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big' }).run()
    const shell = s.transcript.find((m) => m.toolCallId === 'sh1')!
    expect(shell.content).toContain('[output truncated]')
  })

  it('replaces an identical repeated output with a pointer', async () => {
    const cmd = `node -e "console.log('same-output '.repeat(60))"`
    const s = session('run twice', { auto: false })
    const p = new Fake([call('d1', 'shell', { command: cmd }), call('d2', 'shell', { command: cmd + ' ' }), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    const second = s.transcript.find((m) => m.toolCallId === 'd2')!
    expect(second.content).toContain('identical to the output of tool call d1')
    expect(s.savings!.dedupedOutputs).toBe(1)
  })

  it('tool_output refuses an id it does not know', async () => {
    const s = session('x', { auto: false })
    const p = new Fake([call('m1', 'tool_output', { id: 'nope' }), ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', costSettings: () => COST }).run()
    expect(s.transcript.find((m) => m.toolCallId === 'm1')!.content).toContain('No stored output')
  })
})

describe('cost v2 - summaries of old turns (R5)', () => {
  function bigHistory(): { role: 'user' | 'assistant' | 'tool'; content: string; at: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; toolCallId?: string; toolName?: string }[] {
    const msgs: ReturnType<typeof bigHistory> = [{ role: 'user', content: 'refactor the parser', at: 't' }]
    for (let i = 0; i < 24; i++) {
      msgs.push({ role: 'assistant', content: `step ${i}`, at: 't', toolCalls: [{ id: `h${i}`, name: 'read_file', arguments: '{"path":"x.ts"}' }] })
      msgs.push({ role: 'tool', content: `[OK] ${'detail '.repeat(1000)}`, toolCallId: `h${i}`, toolName: 'read_file', at: 't' })
    }
    return msgs
  }

  it('folds old turns into one cheap-model summary, keeps the history, and every later call is smaller', async () => {
    const s = session('refactor the parser', { auto: false })
    s.transcript.push(...bigHistory())
    const respond = (req: ProviderRequest): AssistantTurn | undefined =>
      req.system.includes('compress the working history') ? { content: 'GOAL refactor parser. DONE: read x.ts 24 times. OPEN: nothing.', toolCalls: [] } : undefined
    const p = new Fake([ask('a')], respond, (req) => usageOf(req.system.includes('compress the working history') ? 9000 : 500, 80))
    const meter = new UsageMeter(join(workdir, 'usage-summary.jsonl'))
    await new Engine({ session: s, provider: p, model: 'big', router: router(), costSettings: () => COST, meter }).run()

    const summaryReq = p.requests[0]!
    expect(summaryReq.model).toBe('small')
    const work = p.requests[1]!
    expect(work.model).toBe('mid')
    const sent = work.messages.map((m) => m.content).join('\n')
    expect(sent).toContain('SUMMARY OF EARLIER WORK')
    expect(sent).toContain('DONE: read x.ts 24 times')
    expect(work.messages.length).toBeLessThan(15)
    expect(s.transcript.length).toBeGreaterThan(49) // nothing deleted
    expect(s.transcript.filter((m) => m.summarized).length).toBeGreaterThan(30)
    expect(s.summary!.foldedTokens).toBeGreaterThan(10_000)
    expect(s.modelCalls!.some((c) => c.phase === 'summarise' && c.tier === 'cheap')).toBe(true)
    expect(s.savings!.summarizedTokens).toBeGreaterThan(5_000)

    // The summary call is pure overhead in the savings report (it has no baseline).
    const rep = meter.report()
    expect(rep.calls).toBe(2)
    await meter.flush()
  })

  it('does nothing without a cheaper model (compaction stays the only mechanism)', async () => {
    const s = session('refactor the parser', { auto: false })
    s.transcript.push(...bigHistory())
    const p = new Fake([ask('a')])
    await new Engine({ session: s, provider: p, model: 'big', router: () => ({ ...DEFAULT_ROUTER }), costSettings: () => COST }).run()
    expect(s.summary).toBeUndefined()
    expect(p.requests.length).toBe(1)
  })
})

describe('cost v2 - the meter inside the engine', () => {
  it('records every call with a baseline, and warns (and turns eco on, if opted in) near the limit', async () => {
    const file = join(workdir, 'usage-limits.jsonl')
    const meter = new UsageMeter(file)
    const now = Date.now()
    const old: UsageRecord = { at: new Date(now - 60_000).toISOString(), sid: 'earlier', model: 'big', in: 90_000, cr: 0, cw: 0, out: 0, usd: null, baseIn: 90_000, baseUsd: null }
    meter.add(old)
    const limits = { ...DEFAULT_LIMITS, unit: 'tokens' as const, amount: 100_000, autoEco: true, ecoAt: 85 }
    const events: EngineEvent[] = []
    const s = session('add a thing', { auto: false })
    const p = new Fake([ask('a')], undefined, () => usageOf(1000, 100))
    await new Engine({ session: s, provider: p, model: 'big', router: router({ floor: 'cheap' }), meter, limits: () => limits, onEvent: (e) => events.push(e) }).run()
    const warn = events.find((e) => e.type === 'usage_limit') as { percent: number; level: string; eco: boolean; message: string }
    expect(warn.percent).toBe(90)
    expect(warn.level).toBe('high')
    expect(warn.eco).toBe(true)
    expect((events.find((e) => e.type === 'route') as { reason: string }).reason).toContain('eco')
    const mine = meter.all().filter((r) => r.sid === s.id)
    expect(mine).toHaveLength(1)
    expect(mine[0]!.baseIn).toBeGreaterThan(0)
    expect(mine[0]!.tier).toBeDefined()
    await meter.flush()
  })

  it('does not turn eco on unless the user opted in', async () => {
    const meter = new UsageMeter(join(workdir, 'usage-noeco.jsonl'))
    meter.add({ at: new Date().toISOString(), sid: 'e', model: 'big', in: 99_000, cr: 0, cw: 0, out: 0, usd: null, baseIn: 99_000, baseUsd: null })
    const events: EngineEvent[] = []
    const s = session('add a thing', { auto: false })
    await new Engine({ session: s, provider: new Fake([ask('a')]), model: 'big', router: router({ floor: 'cheap' }), meter, limits: () => ({ ...DEFAULT_LIMITS, unit: 'tokens', amount: 100_000 }), onEvent: (e) => events.push(e) }).run()
    expect((events.find((e) => e.type === 'usage_limit') as { eco: boolean }).eco).toBe(false)
    expect((events.find((e) => e.type === 'route') as { reason: string }).reason).not.toContain('eco')
    await meter.flush()
  })
})
