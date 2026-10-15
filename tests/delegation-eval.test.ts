import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { Engine } from '../src/core/engine.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import type { EngineEvent } from '../src/core/types.js'
import { buildSystemPrompt, DELEGATION_NOTE } from '../src/core/prompt.js'
import { toolDefinitions } from '../src/tools/registry.js'
import { delegateTool } from '../src/tools/control-tools.js'
import { agentsText, applyAgentEvent, swarmSummaryLine, type SwarmView } from '../src/tui/agents.js'

/**
 * An eval-style check of the delegation path with no real model: a scripted "model" that behaves the way the
 * prompt and the tool description ask (one delegate call with every independent task, dependencies for what
 * must be ordered), and sub-agents that take real time, so parallelism is something we can MEASURE.
 */

let work: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'vara-eval-'))
})
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) })
const session = () => createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'Review the auth, billing and search modules', acceptance: ['all three reviewed'], cwd: work, auto: false }), DEFAULT_CONFIG)

class Lab implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  running = 0
  peak = 0
  started: string[] = []
  parentTurns = 0
  constructor(private readonly opts: { childMs: number; plan: Array<Record<string, unknown>>; childFails?: (prompt: string) => boolean }) {}

  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    const isChild = req.system.includes('You are a sub-agent')
    if (!isChild) {
      this.parentTurns++
      const names = (req.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
      // The "model" follows the guidance only if the guidance and the tool are really there.
      const guided = req.system.includes('ONE call with all the independent tasks') && names.includes('delegate')
      const turn: AssistantTurn =
        this.parentTurns === 1 && guided
          ? { content: '', toolCalls: [call('d', 'delegate', { tasks: this.opts.plan })] }
          : { content: 'All reviewed: see the merged report.', toolCalls: [call('c', 'ask_user', { question: 'anything else you want me to look at?' })] }
      if (turn.content) yield { type: 'text', delta: turn.content }
      yield { type: 'done', result: turn }
      return
    }
    const prompt = req.messages.map((m) => m.content).join('\n')
    const title = /Your task: (.*)/.exec(prompt)?.[1]?.slice(0, 40) ?? 'task'
    this.running++
    this.peak = Math.max(this.peak, this.running)
    this.started.push(title)
    await new Promise((r) => setTimeout(r, this.opts.childMs))
    this.running--
    if (this.opts.childFails?.(prompt)) {
      yield { type: 'error', message: 'provider exploded' }
      return
    }
    const turn: AssistantTurn = { content: `REPORT(${title}): looks fine`, toolCalls: [] }
    yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

const reviewPlan = [
  { id: 'auth', title: 'review auth', prompt: 'Review src/auth for bugs. Report file:line findings, most severe first.', role: 'reviewer' },
  { id: 'billing', title: 'review billing', prompt: 'Review src/billing for bugs. Report file:line findings, most severe first.', role: 'reviewer' },
  { id: 'search', title: 'review search', prompt: 'Review src/search for bugs. Report file:line findings, most severe first.', role: 'reviewer' },
]

describe('delegation, measured', () => {
  it('three independent reviews go out in ONE call and really run at the same time', async () => {
    const lab = new Lab({ childMs: 80, plan: reviewPlan })
    const s = session()
    const events: EngineEvent[] = []
    await new Engine({ session: s, provider: lab, onEvent: (e) => events.push(e) }).run()

    expect(lab.peak).toBe(3) // all three overlapped
    const delegateCalls = s.transcript.flatMap((m) => m.toolCalls ?? []).filter((c) => c.name === 'delegate')
    expect(delegateCalls).toHaveLength(1)

    const merged = s.transcript.find((m) => m.toolName === 'delegate')!.content
    expect(merged).toMatch(/Swarm result: 3 done, 0 failed, 0 skipped/)
    for (const m of ['src/auth', 'src/billing', 'src/search']) expect(merged).toContain(`REPORT(Review ${m}`)

    // …and the events a UI needs are all there
    const sub = events.filter((e): e is Extract<EngineEvent, { type: 'subagent' }> => e.type === 'subagent')
    expect(new Set(sub.map((e) => e.swarm))).toEqual(new Set([1]))
    expect(sub.filter((e) => e.status === 'running').length).toBeGreaterThanOrEqual(3)
    const finished = sub.filter((e) => e.status === 'done')
    expect(finished).toHaveLength(3)
    for (const f of finished) {
      expect(f.role).toBe('reviewer')
      expect(f.kind).toBe('explore')
      expect(f.report).toMatch(/REPORT/)
      expect(typeof f.calls).toBe('number')
      expect(f).toHaveProperty('costUsd') // null = unknown, never silently 0
    }
    const report = events.find((e) => e.type === 'swarm_report')
    expect(report && report.type === 'swarm_report' && report.done).toBe(3)
    expect(report && report.type === 'swarm_report' && report.merged).toMatch(/Swarm result/)
  })

  it('a dependency makes the second agent wait, and a failure skips what depended on it', async () => {
    const plan = [
      { id: 'impl', title: 'implement', prompt: 'Implement the change in src/a.ts only.', role: 'implementer' },
      { id: 'test', title: 'test it', prompt: 'Run the tests that cover src/a.ts.', role: 'tester', dependsOn: ['impl'] },
    ]
    const ok = new Lab({ childMs: 40, plan })
    await new Engine({ session: session(), provider: ok }).run()
    expect(ok.peak).toBe(1) // never together
    expect(ok.started[0]).toMatch(/Implement/)

    const bad = new Lab({ childMs: 10, plan, childFails: (p) => /Implement the change/.test(p) })
    const s = session()
    const events: EngineEvent[] = []
    await new Engine({ session: s, provider: bad, onEvent: (e) => events.push(e) }).run()
    const merged = s.transcript.find((m) => m.toolName === 'delegate')!.content
    expect(merged).toMatch(/1 failed, 1 skipped/)
    expect(events.some((e) => e.type === 'subagent' && e.id === 'test' && e.status === 'skipped')).toBe(true)
  })

  it('the user can cancel one running agent: it stops, is reported cancelled, and the others finish', async () => {
    const lab = new Lab({ childMs: 400, plan: reviewPlan })
    const s = session()
    const events: EngineEvent[] = []
    const engine: Engine = new Engine({
      session: s,
      provider: lab,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'subagent' && e.id === 'billing' && e.status === 'running' && !events.some((x) => x.type === 'subagent' && x.cancelled)) setTimeout(() => engine.cancelSubagents('billing'), 20)
      },
    })
    await engine.run()
    const sub = events.filter((e): e is Extract<EngineEvent, { type: 'subagent' }> => e.type === 'subagent')
    const billing = sub.filter((e) => e.id === 'billing').at(-1)!
    expect(billing.status).toBe('failed')
    expect(billing.cancelled).toBe(true)
    expect(sub.filter((e) => e.id === 'auth').at(-1)!.status).toBe('done')
    const merged = s.transcript.find((m) => m.toolName === 'delegate')!.content
    expect(merged).toMatch(/CANCELLED by the user/)
  })

  it('cancelling the whole swarm skips what is still queued', async () => {
    const plan = [
      { id: 'a', title: 'a', prompt: 'Review src/a for bugs and report.', role: 'reviewer' },
      { id: 'b', title: 'b', prompt: 'Review src/b for bugs and report.', role: 'reviewer', dependsOn: ['a'] },
    ]
    const lab = new Lab({ childMs: 400, plan })
    const s = session()
    const events: EngineEvent[] = []
    const engine: Engine = new Engine({
      session: s,
      provider: lab,
      onEvent: (e) => {
        events.push(e)
        if (e.type === 'subagent' && e.id === 'a' && e.status === 'running' && !events.some((x) => x.type === 'subagent' && x.cancelled)) setTimeout(() => engine.cancelSubagents(), 20)
      },
    })
    await engine.run()
    expect(events.some((e) => e.type === 'subagent' && e.id === 'b' && e.status === 'skipped')).toBe(true)
    expect(lab.started).toHaveLength(1)
    expect(engine.cancelSubagents()).toBe(false) // nothing left to cancel
  })
})

describe('what makes the model delegate well', () => {
  it('the work prompt carries the delegation guidance and the tool description says "one call, parallel"', () => {
    const s = session()
    const prompt = buildSystemPrompt(s, { intent: 'task' })
    expect(prompt).toContain(DELEGATION_NOTE)
    expect(prompt).toMatch(/ONE call with all the independent tasks/)
    expect(prompt).toMatch(/dependsOn/)
    expect(delegateTool.description).toMatch(/IN PARALLEL/)
    expect(delegateTool.description).toMatch(/ONE call/)
    expect(delegateTool.description).toMatch(/self-contained/)
  })

  it('a sub-agent is told it cannot delegate, and is not even offered the tool', () => {
    const s = session()
    const p = buildSystemPrompt(s, { intent: 'question', subagent: true })
    expect(p).toMatch(/cannot delegate/)
    expect(p).not.toContain('ONE call with all the independent tasks')
    const names = (toolDefinitions('build', 'task', { canDelegate: false }) as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).not.toContain('delegate')
  })

  it('the system-awareness block is only in the prompt of an owner session that can manage itself', () => {
    const s = session()
    expect(buildSystemPrompt(s, { intent: 'task' })).not.toContain('Your own environment')
    const withSelf = buildSystemPrompt(s, { intent: 'task', selfManage: true })
    expect(withSelf).toContain('Your own environment')
    expect(withSelf).toMatch(/can never read API keys/)
    expect(buildSystemPrompt(s, { intent: 'task', selfManage: true, subagent: true })).not.toContain('Your own environment')
  })
})

describe('the terminal view of agents', () => {
  const ev = (over: Record<string, unknown>): EngineEvent => ({ type: 'subagent', id: 'a', title: 'review auth', status: 'waiting', swarm: 1, ...over }) as EngineEvent

  it('folds events into rows with status, steps, cost and report; unknown cost is never zero', () => {
    let st: SwarmView[] = []
    st = applyAgentEvent(st, ev({ role: 'reviewer', kind: 'explore' }), 1000)
    st = applyAgentEvent(st, ev({ id: 'b', title: 'tests', role: 'tester', dependsOn: ['a'] }), 1000)
    st = applyAgentEvent(st, ev({ status: 'running', detail: 'grep', steps: 2 }), 2000)
    expect(agentsText(st, 5000)).toMatch(/⧉ review auth \[reviewer\] grep · 2 steps · 3s/)
    expect(agentsText(st, 5000)).toMatch(/○ tests \[tester\] ← a waiting for its dependencies/)
    st = applyAgentEvent(st, ev({ status: 'done', calls: 4, costUsd: null, report: 'found 2 bugs' }), 6000)
    const row = st[0]!.rows[0]!
    expect(row).toMatchObject({ status: 'done', calls: 4, costUsd: null, report: 'found 2 bugs', steps: 2 })
    expect(agentsText(st, 7000)).toMatch(/4 calls · cost unknown/)
    st = applyAgentEvent(st, { type: 'swarm_report', swarm: 1, merged: 'M', modelCalls: 4, costUsd: null, done: 1, failed: 0, skipped: 1 }, 8000)
    expect(swarmSummaryLine(st[0]!)).toMatch(/1 done, 1 skipped · 4 model calls · cost unknown/)
  })

  it('a second delegate call is a second swarm; only the newest few are kept', () => {
    let st: SwarmView[] = []
    for (let n = 1; n <= 9; n++) st = applyAgentEvent(st, ev({ swarm: n, id: `x${n}` }))
    expect(st.map((s) => s.swarm)).toEqual([4, 5, 6, 7, 8, 9])
  })
})
