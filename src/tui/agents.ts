import type { EngineEvent } from '../core/types.js'
import { formatUsd } from '../llm/cost.js'

/**
 * The terminal's model of "who is working on what": a pure reducer over the engine's `subagent` and
 * `swarm_report` events, so the side panel, the /agents screen and the conversation lines all read the same
 * facts (and the logic is testable without rendering anything).
 */

export type AgentStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export interface AgentRow {
  id: string
  title: string
  role?: string
  kind?: 'explore' | 'work'
  status: AgentStatus
  dependsOn: string[]
  /** What it is doing now (the tool it last called), or why it was skipped. */
  detail?: string
  steps: number
  calls?: number
  /** null = unknown (never shown as zero); undefined = not finished yet. */
  costUsd?: number | null
  report?: string
  cancelled?: boolean
  startedAt?: number
  endedAt?: number
}

export interface SwarmReport {
  merged: string
  modelCalls: number
  costUsd: number | null
  done: number
  failed: number
  skipped: number
}

export interface SwarmView {
  swarm: number
  rows: AgentRow[]
  report?: SwarmReport
  startedAt: number
}

const KEEP_SWARMS = 6

/** Fold one engine event into the list of swarms (newest last). Returns the same array for unrelated events. */
export function applyAgentEvent(state: SwarmView[], event: EngineEvent, now: number = Date.now()): SwarmView[] {
  if (event.type === 'subagent') {
    const n = event.swarm ?? 1
    const next = state.map((s) => ({ ...s, rows: [...s.rows] }))
    let view = next.find((s) => s.swarm === n)
    if (!view) {
      view = { swarm: n, rows: [], startedAt: now }
      next.push(view)
    }
    const i = view.rows.findIndex((r) => r.id === event.id)
    const prev: AgentRow = i >= 0 ? view.rows[i]! : { id: event.id, title: event.title, status: 'waiting', dependsOn: [], steps: 0 }
    const row: AgentRow = {
      ...prev,
      title: event.title,
      status: event.status,
      ...(event.role ? { role: event.role } : {}),
      ...(event.kind ? { kind: event.kind } : {}),
      dependsOn: event.dependsOn ?? prev.dependsOn,
      ...(event.detail !== undefined ? { detail: event.detail } : event.status === 'done' || event.status === 'failed' ? { detail: undefined } : {}),
      steps: event.steps ?? prev.steps,
      ...(event.calls !== undefined ? { calls: event.calls } : {}),
      ...(event.costUsd !== undefined ? { costUsd: event.costUsd } : {}),
      ...(event.report !== undefined ? { report: event.report } : {}),
      ...(event.cancelled ? { cancelled: true } : {}),
    }
    if (event.status === 'running' && prev.startedAt === undefined) row.startedAt = now
    if ((event.status === 'done' || event.status === 'failed' || event.status === 'skipped') && row.endedAt === undefined) row.endedAt = now
    if (i >= 0) view.rows[i] = row
    else view.rows.push(row)
    return next.slice(-KEEP_SWARMS)
  }
  if (event.type === 'swarm_report') {
    const next = state.map((s) => (s.swarm === event.swarm ? { ...s, report: { merged: event.merged, modelCalls: event.modelCalls, costUsd: event.costUsd, done: event.done, failed: event.failed, skipped: event.skipped } } : s))
    return next
  }
  return state
}

export function activeCount(view: SwarmView | undefined): { running: number; waiting: number; done: number; failed: number; skipped: number } {
  const c = { running: 0, waiting: 0, done: 0, failed: 0, skipped: 0 }
  for (const r of view?.rows ?? []) c[r.status]++
  return c
}

/** True while any agent of the swarm is still running or waiting. */
export function isBusy(view: SwarmView | undefined): boolean {
  const c = activeCount(view)
  return c.running + c.waiting > 0
}

/** Known cost of a swarm: a number only when EVERY finished agent's cost is known; unknown is never zero. */
export function swarmCost(view: SwarmView): { usd: number | null; atLeast: number | null } {
  if (view.report) return { usd: view.report.costUsd, atLeast: null }
  let known = 0
  let any = false
  let unknown = false
  for (const r of view.rows) {
    if (r.costUsd === undefined) continue
    if (r.costUsd === null) unknown = true
    else (any = true, (known += r.costUsd))
  }
  if (!any && !unknown) return { usd: null, atLeast: null }
  return unknown ? { usd: null, atLeast: any ? known : null } : { usd: known, atLeast: null }
}

export function costText(c: { usd: number | null; atLeast: number | null }, started = true): string {
  if (c.usd !== null) return formatUsd(c.usd)
  if (c.atLeast !== null) return `≥ ${formatUsd(c.atLeast)}`
  return started ? 'cost unknown' : '—'
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

export const STATUS_GLYPH: Record<AgentStatus, string> = { waiting: '○', running: '⧉', done: '✓', failed: '✗', skipped: '–' }

/** One agent as a single line (side panel and conversation). */
export function agentLine(r: AgentRow, now: number, opts: { width?: number; dependencies?: boolean } = {}): string {
  const bits: string[] = [`${STATUS_GLYPH[r.status]} ${r.title}`]
  if (r.role) bits.push(`[${r.role}]`)
  if (opts.dependencies !== false && r.dependsOn.length) bits.push(`← ${r.dependsOn.join(', ')}`)
  if (r.status === 'running') bits.push(`${r.detail ?? 'working'} · ${r.steps} step${r.steps === 1 ? '' : 's'}${r.startedAt ? ` · ${formatDuration(now - r.startedAt)}` : ''}`)
  else if (r.status === 'waiting') bits.push(r.dependsOn.length ? 'waiting for its dependencies' : 'queued')
  else if (r.status === 'skipped') bits.push(`skipped${r.detail ? `: ${r.detail}` : ''}`)
  else if (r.status === 'failed') bits.push(r.cancelled ? 'cancelled' : 'failed')
  else bits.push(`done${r.startedAt && r.endedAt ? ` · ${formatDuration(r.endedAt - r.startedAt)}` : ''}`)
  if ((r.status === 'done' || r.status === 'failed') && r.calls !== undefined) bits.push(`${r.calls} call${r.calls === 1 ? '' : 's'} · ${r.costUsd === null || r.costUsd === undefined ? 'cost unknown' : formatUsd(r.costUsd)}`)
  const line = bits.join(' ')
  const w = opts.width
  return w && line.length > w ? `${line.slice(0, Math.max(1, w - 1))}…` : line
}

/** The line shown in the conversation when a swarm ends. */
export function swarmSummaryLine(v: SwarmView): string {
  const r = v.report
  const c = activeCount(v)
  const done = r?.done ?? c.done
  const failed = r?.failed ?? c.failed
  const skipped = r?.skipped ?? c.skipped
  const calls = r?.modelCalls
  return `agents #${v.swarm}: ${done} done${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}${calls !== undefined ? ` · ${calls} model calls` : ''} · ${costText(swarmCost(v))} — /agents for the reports`
}

/** What /agents prints as plain text (also used by tests and the `/agents report` command). */
export function agentsText(state: SwarmView[], now: number = Date.now()): string {
  if (!state.length) return 'No sub-agents have run in this session yet. The agent starts them with `delegate` when work splits into independent pieces.'
  const v = state[state.length - 1]!
  const lines = [`Agents #${v.swarm} — ${isBusy(v) ? 'working' : 'finished'} · ${costText(swarmCost(v))}`]
  for (const r of v.rows) lines.push(`  ${agentLine(r, now)}`)
  return lines.join('\n')
}
