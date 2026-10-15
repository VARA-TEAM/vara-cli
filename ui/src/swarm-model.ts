/**
 * The view-model of sub-agents ("swarm"): everything the Agents panel and the conversation show.
 * Pure and unit-tested. Two sources feed it:
 *   1. live host events: `tool_start delegate`, `subagent` (per task status), `tool_end delegate`;
 *   2. the saved transcript: the `delegate` call's arguments (the plan) and its merged report.
 * While a task runs the host reports its tool-call count; when it ends, its model calls, cost (null =
 * unknown, never shown as zero) and report. Older hosts send neither: the merged report written at the
 * end of the swarm is then the only source of totals. Nothing is invented where nothing was reported.
 */
import type { ChatItem } from './transcript'
import type { HostEvent } from './types'

export type AgentStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'
export const TERMINAL: ReadonlySet<AgentStatus> = new Set(['done', 'failed', 'skipped'])

export interface AgentRow {
  id: string
  title: string
  role?: string
  kind?: 'explore' | 'work'
  status: AgentStatus
  dependsOn: string[]
  /** What it is doing now (the tool it is using) or why it was skipped. */
  detail?: string
  /** Number of times it switched to a different tool: a coarse progress count. */
  steps: number
  stepAt: number[]
  startedAt?: number
  endedAt?: number
  /** Its part of the merged report (only after the swarm finished). */
  report?: string
  /** Finished only, from the host: model calls it used. */
  calls?: number
  /** Finished only: its cost; null = unknown (never zero). Absent = not reported. */
  costUsd?: number | null
  /** The person cancelled this agent (or the whole swarm). */
  cancelled?: boolean
}

export interface SwarmRunModel {
  /** The delegate call's id. */
  key: string
  live: boolean
  rejected?: string
  agents: AgentRow[]
  startedAt?: number
  endedAt?: number
  modelCalls?: number
  /** null = cost unknown (never shown as zero). */
  costUsd?: number | null
  /** When the cost is unknown but a lower bound was reported. */
  costAtLeast?: number
  merged?: string
}

export interface SwarmState {
  runs: SwarmRunModel[]
}
export const EMPTY_SWARM: SwarmState = { runs: [] }
const MAX_RUNS = 20

/* ---------- report parsing ---------- */

export interface ParsedReport {
  done: number
  failed: number
  skipped: number
  modelCalls: number
  costUsd: number | null
  costAtLeast?: number
  sections: Array<{ id: string; title: string; role?: string; status: AgentStatus; report: string }>
}

const HEAD = /^## Swarm result: (\d+) done, (\d+) failed, (\d+) skipped · (\d+) model calls · (?:cost \$([\d.]+)|cost unknown \(at least \$([\d.]+)\)|cost unknown)/

/** Read the merged report the engine writes (see swarm.ts runSwarm). Null when it is something else. */
export function parseSwarmReport(text: string): ParsedReport | null {
  const h = HEAD.exec(text)
  if (!h) return null
  const out: ParsedReport = {
    done: Number(h[1]),
    failed: Number(h[2]),
    skipped: Number(h[3]),
    modelCalls: Number(h[4]),
    costUsd: h[5] !== undefined ? Number(h[5]) : null,
    sections: [],
  }
  if (h[6] !== undefined) out.costAtLeast = Number(h[6])
  const parts = text.split(/\n(?=### )/).slice(1)
  for (const p of parts) {
    const nl = p.indexOf('\n')
    const head = nl < 0 ? p : p.slice(0, nl)
    const body = nl < 0 ? '' : p.slice(nl + 1)
    const m = /^### (\S+) · (.*) — (DONE|FAILED|SKIPPED)$/.exec(head)
    if (!m) continue
    let title = m[2]!
    let role: string | undefined
    const r = /^(.*) \[([^\]]+)\]$/.exec(title)
    if (r) (title = r[1]!, (role = r[2]!))
    // The closing note the engine appends belongs to the swarm, not to the last agent.
    const report = body.replace(/\n\nSub-agents that edit files have finished:[\s\S]*$/, '').trim()
    out.sections.push({ id: m[1]!, title, ...(role ? { role } : {}), status: m[3]!.toLowerCase() as AgentStatus, report })
  }
  return out
}

/* ---------- building rows ---------- */

const blank = (id: string, title: string): AgentRow => ({ id, title, status: 'waiting', dependsOn: [], steps: 0, stepAt: [] })

interface PlannedTask {
  id?: string
  title?: string
  role?: string
  kind?: 'explore' | 'work'
  dependsOn?: string[]
}

/** The plan out of a delegate call's JSON arguments (ids default to t1, t2… as the engine does). */
export function planFromArgs(args: string): AgentRow[] {
  try {
    const tasks = (JSON.parse(args) as { tasks?: PlannedTask[] }).tasks
    if (!Array.isArray(tasks)) return []
    return tasks.map((t, i) => ({
      ...blank(String(t.id ?? '').trim().slice(0, 24) || `t${i + 1}`, String(t.title ?? `task ${i + 1}`)),
      ...(t.role ? { role: String(t.role) } : {}),
      ...(t.kind ? { kind: t.kind } : {}),
      dependsOn: Array.isArray(t.dependsOn) ? t.dependsOn.map(String) : [],
    }))
  } catch {
    return []
  }
}

function applyReport(run: SwarmRunModel, output: string): SwarmRunModel {
  const rej = /^Swarm plan rejected: ?([\s\S]*)$/.exec(output)
  if (rej) return { ...run, rejected: rej[1]!.trim() || 'rejected', merged: output }
  const parsed = parseSwarmReport(output)
  if (!parsed) return { ...run, merged: output }
  const agents = run.agents.map((a) => {
    const s = parsed.sections.find((x) => x.id === a.id)
    return s ? { ...a, status: s.status, report: s.report, ...(s.role && !a.role ? { role: s.role } : {}), ...(s.report.startsWith('CANCELLED') ? { cancelled: true } : {}) } : a
  })
  for (const s of parsed.sections) if (!agents.some((a) => a.id === s.id)) agents.push({ ...blank(s.id, s.title), status: s.status, report: s.report, ...(s.role ? { role: s.role } : {}) })
  return { ...run, agents, modelCalls: parsed.modelCalls, costUsd: parsed.costUsd, ...(parsed.costAtLeast !== undefined ? { costAtLeast: parsed.costAtLeast } : {}), merged: output }
}

/** Runs recorded in the saved transcript (survive a reload). */
export function swarmFromTranscript(items: ChatItem[]): SwarmRunModel[] {
  const runs: SwarmRunModel[] = []
  for (const it of items) {
    if (it.kind !== 'tool' || it.name !== 'delegate') continue
    let run: SwarmRunModel = { key: it.id, live: false, agents: planFromArgs(it.args) }
    if (it.output !== undefined) run = applyReport(run, it.output)
    runs.push(run)
  }
  return runs.slice(-MAX_RUNS)
}

/* ---------- live reducer ---------- */

const upsertRun = (st: SwarmState, run: SwarmRunModel): SwarmState => {
  const i = st.runs.findIndex((r) => r.key === run.key)
  const runs = i < 0 ? [...st.runs, run] : st.runs.map((r, j) => (j === i ? run : r))
  return { runs: runs.slice(-MAX_RUNS) }
}

const openRun = (st: SwarmState): SwarmRunModel | undefined => [...st.runs].reverse().find((r) => r.live)

/** Fold one host event into the live state. `now` is passed in so tests are deterministic. */
export function reduceSwarm(st: SwarmState, e: HostEvent, now: number): SwarmState {
  if (e.type === 'tool_start' && e['name'] === 'delegate') {
    return upsertRun(st, { key: String(e['id'] ?? `live-${now}`), live: true, startedAt: now, agents: planFromArgs(String(e['args'] ?? '')) })
  }
  if (e.type === 'subagent') {
    const id = String(e['id'] ?? '')
    if (!id) return st
    const status = e['status'] as AgentStatus
    const run = openRun(st) ?? { key: `live-${now}`, live: true, startedAt: now, agents: [] }
    const existing = run.agents.find((a) => a.id === id)
    const prev: AgentRow = existing ?? blank(id, String(e['title'] ?? id))
    const detail = typeof e['detail'] === 'string' && e['detail'] ? e['detail'] : undefined
    const next: AgentRow = { ...prev, title: String(e['title'] ?? prev.title), status }
    if (typeof e['role'] === 'string') next.role = e['role']
    if (e['kind'] === 'explore' || e['kind'] === 'work') next.kind = e['kind']
    if (typeof e['calls'] === 'number') next.calls = e['calls']
    if ('costUsd' in e && (typeof e['costUsd'] === 'number' || e['costUsd'] === null)) next.costUsd = e['costUsd'] as number | null
    if (typeof e['report'] === 'string' && e['report']) next.report = e['report']
    if (e['cancelled'] === true) next.cancelled = true
    if (Array.isArray(e['dependsOn'])) next.dependsOn = (e['dependsOn'] as unknown[]).map(String)
    if (status === 'running' && !next.startedAt) next.startedAt = now
    if (TERMINAL.has(status) && !next.endedAt) {
      next.endedAt = now
      if (status === 'skipped' && !next.startedAt) delete next.startedAt
    }
    // The host counts tool calls; without that count, a change of tool is the best sign of progress.
    const hostSteps = typeof e['steps'] === 'number' ? e['steps'] : null
    if (status === 'running' && hostSteps !== null) {
      if (hostSteps > prev.steps) (next.steps = hostSteps, (next.stepAt = [...prev.stepAt, now].slice(-40)))
    } else if (status === 'running' && detail && detail !== prev.detail) {
      next.steps = prev.steps + 1
      next.stepAt = [...prev.stepAt, now].slice(-40)
    }
    if (detail) next.detail = detail
    else if (status !== 'running' && status !== 'skipped') delete next.detail
    const agents = existing ? run.agents.map((a) => (a.id === id ? next : a)) : [...run.agents, next]
    return upsertRun(st, { ...run, agents })
  }
  if (e.type === 'tool_end' && e['name'] === 'delegate') {
    const key = String(e['id'] ?? '')
    const run = st.runs.find((r) => r.key === key) ?? openRun(st)
    if (!run) return st
    const ended = applyReport({ ...run, live: false, endedAt: now }, String(e['output'] ?? ''))
    return upsertRun(st, ended)
  }
  if (e.type === 'swarm_report') {
    // The host's own summary of a finished swarm (the same text the delegate call returns).
    const run = openRun(st)
    if (!run || typeof e['merged'] !== 'string') return st
    return upsertRun(st, applyReport(run, e['merged']))
  }
  if (e.type === 'state' && e['state'] !== 'running') {
    // The session stopped while a swarm was open: nothing is running any more.
    if (!st.runs.some((r) => r.live)) return st
    return {
      runs: st.runs.map((r) =>
        r.live
          ? { ...r, live: false, endedAt: now, agents: r.agents.map((a) => (a.status === 'running' ? { ...a, status: 'failed' as const, detail: 'interrupted', endedAt: now } : a.status === 'waiting' ? { ...a, status: 'skipped' as const, detail: 'interrupted' } : a)) }
          : r,
      ),
    }
  }
  return st
}

/**
 * History from the transcript, enriched with live timing. A run seen on both sides keeps the saved
 * report/status and the live start/end/steps.
 */
export function mergeRuns(history: SwarmRunModel[], live: SwarmRunModel[]): SwarmRunModel[] {
  const out = history.map((h) => {
    const l = live.find((x) => x.key === h.key)
    if (!l) return h
    const saved = h.merged !== undefined
    const agents = h.agents.map((a) => {
      const la = l.agents.find((x) => x.id === a.id)
      if (!la) return a
      const timing: Partial<AgentRow> = {}
      if (la.startedAt !== undefined) timing.startedAt = la.startedAt
      if (la.endedAt !== undefined) timing.endedAt = la.endedAt
      // What the host reported per agent rides along, whichever side knows the rest.
      if (la.calls !== undefined) timing.calls = la.calls
      if (la.costUsd !== undefined) timing.costUsd = la.costUsd
      if (la.cancelled) timing.cancelled = true
      if (la.kind && !a.kind) timing.kind = la.kind
      if (la.report && !a.report) timing.report = la.report
      return { ...a, ...timing, steps: la.steps, stepAt: la.stepAt, ...(la.detail && !saved ? { detail: la.detail } : {}), ...(saved ? {} : { status: la.status, dependsOn: la.dependsOn.length ? la.dependsOn : a.dependsOn, ...(la.role ? { role: la.role } : {}) }) }
    })
    return { ...h, live: saved ? false : l.live, agents, ...(l.startedAt !== undefined ? { startedAt: l.startedAt } : {}), ...(l.endedAt !== undefined ? { endedAt: l.endedAt } : {}) }
  })
  for (const l of live) if (!out.some((h) => h.key === l.key)) out.push(l)
  return out
}

/* ---------- derived facts ---------- */

export interface Totals {
  /** Model calls of the agents that have finished (or the whole swarm's, once it has ended). */
  calls: number
  /** Known cost; null when any finished agent's cost is unknown (then `atLeast` is the part that is known). */
  costUsd: number | null
  atLeast: number
  /** At least one agent has reported calls or a cost. */
  any: boolean
}

/** What the run has cost so far, without ever turning an unknown cost into zero. */
export function runTotals(run: SwarmRunModel): Totals {
  if (run.modelCalls !== undefined) return { calls: run.modelCalls, costUsd: run.costUsd ?? null, atLeast: run.costAtLeast ?? run.costUsd ?? 0, any: true }
  let calls = 0
  let known = 0
  let unknown = false
  let any = false
  for (const a of run.agents) {
    if (a.calls !== undefined) (calls += a.calls, (any = true))
    if (a.costUsd === null) (unknown = true, (any = true))
    else if (typeof a.costUsd === 'number') (known += a.costUsd, (any = true))
  }
  return { calls, costUsd: any && !unknown ? known : null, atLeast: known, any }
}

export function countStatus(run: SwarmRunModel): Record<AgentStatus, number> {
  const c: Record<AgentStatus, number> = { waiting: 0, running: 0, done: 0, failed: 0, skipped: 0 }
  for (const a of run.agents) c[a.status] += 1
  return c
}

export type RunStatus = 'running' | 'done' | 'failed' | 'partial' | 'rejected' | 'planned'
export function runStatus(run: SwarmRunModel): RunStatus {
  if (run.rejected) return 'rejected'
  const c = countStatus(run)
  if (c.running > 0 || (run.live && c.waiting > 0)) return 'running'
  if (c.waiting === run.agents.length) return run.live ? 'running' : 'planned'
  if (c.failed > 0) return 'failed'
  if (c.skipped > 0) return 'partial'
  return 'done'
}

/** Rows of the dependency graph: `levels(...)[0]` has no dependencies. Cycles cannot happen (the engine rejects them) but never loop. */
export function levels(agents: AgentRow[]): string[][] {
  const ids = new Set(agents.map((a) => a.id))
  const level = new Map<string, number>()
  const depth = (id: string, seen: Set<string>): number => {
    if (level.has(id)) return level.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const a = agents.find((x) => x.id === id)
    const l = a ? Math.max(-1, ...a.dependsOn.filter((d) => ids.has(d)).map((d) => depth(d, seen))) + 1 : 0
    level.set(id, l)
    return l
  }
  for (const a of agents) depth(a.id, new Set())
  const rows: string[][] = []
  for (const a of agents) (rows[level.get(a.id)!] ??= []).push(a.id)
  return rows.map((r) => r ?? [])
}

export interface Lane {
  id: string
  /** Fractions of the track width, 0..1. */
  x0: number
  x1: number
  /** Bar drawn from real timestamps (otherwise a schematic position from the dependency level). */
  timed: boolean
  /** Positions of tool switches on the bar, 0..1. */
  ticks: number[]
  open: boolean
}

/**
 * Lane geometry for the Trace view. With real timestamps the bar spans start..end (or now, while it
 * runs). Without them (a run read back from the saved transcript) lanes are placed by dependency
 * level, which still shows who waited for whom, and are flagged `timed: false`.
 */
export function traceLayout(run: SwarmRunModel, now: number): Lane[] {
  const rows = levels(run.agents)
  const levelOf = new Map<string, number>()
  rows.forEach((r, i) => r.forEach((id) => levelOf.set(id, i)))
  const started = run.agents.filter((a) => a.startedAt !== undefined)
  const timedAny = started.length > 0
  const t0 = timedAny ? Math.min(...started.map((a) => a.startedAt!)) : 0
  const tEnd = timedAny ? Math.max(run.live ? now : t0, ...started.map((a) => a.endedAt ?? (run.live ? now : a.startedAt!))) : 0
  const span = Math.max(1000, tEnd - t0)
  const n = Math.max(1, rows.length)
  const gap = 0.02
  const lanes: Lane[] = []
  const byId = new Map<string, Lane>()
  for (const a of run.agents) {
    let lane: Lane
    if (timedAny && a.startedAt !== undefined) {
      const x0 = (a.startedAt - t0) / span
      const end = a.endedAt ?? (run.live && a.status === 'running' ? now : a.startedAt)
      const x1 = Math.max(x0 + 0.012, (end - t0) / span)
      lane = { id: a.id, x0: Math.min(1, x0), x1: Math.min(1, x1), timed: true, ticks: a.stepAt.map((t) => Math.min(1, Math.max(0, (t - t0) / span))), open: a.status === 'running' }
    } else if (timedAny) {
      // Not started yet (waiting) or skipped: a short placeholder after what it waits for.
      const after = Math.max(0, ...a.dependsOn.map((d) => byId.get(d)?.x1 ?? 0))
      lane = { id: a.id, x0: Math.min(0.96, after + gap), x1: Math.min(1, Math.min(0.96, after + gap) + 0.04), timed: false, ticks: [], open: false }
    } else {
      const l = levelOf.get(a.id) ?? 0
      lane = { id: a.id, x0: l / n + gap / 2, x1: (l + 1) / n - gap / 2, timed: false, ticks: [], open: a.status === 'running' }
    }
    lanes.push(lane)
    byId.set(a.id, lane)
  }
  return lanes
}

/** Elapsed milliseconds of an agent (null when it never started). */
export function elapsedMs(a: AgentRow, now: number): number | null {
  if (a.startedAt === undefined) return null
  return Math.max(0, (a.endedAt ?? (a.status === 'running' ? now : a.startedAt)) - a.startedAt)
}

export function formatDuration(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

export interface SwarmSummary {
  /** Agents running right now, across all live runs. */
  running: number
  /** Agents in the run that is open, or in the latest run. */
  total: number
  done: number
  active: SwarmRunModel | null
  /** The latest run is live. */
  live: boolean
}

export function summarizeSwarm(runs: SwarmRunModel[]): SwarmSummary {
  const active = [...runs].reverse().find((r) => r.live) ?? runs[runs.length - 1] ?? null
  if (!active) return { running: 0, total: 0, done: 0, active: null, live: false }
  const c = countStatus(active)
  return { running: active.live ? c.running : 0, total: active.agents.length, done: c.done, active, live: active.live }
}
