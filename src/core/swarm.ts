/**
 * Swarm: several sub-agents working on one job.
 *
 * A plan is a small task list with named roles and optional dependencies
 * ("tests run after the implementation"). The runner starts tasks as their
 * dependencies finish, never more than `maxParallel` at once, stops starting
 * new ones when the swarm's model-call or cost budget is spent, and merges every
 * report into one answer. It knows nothing about engines: the caller supplies
 * `run` (engine.ts builds the ephemeral sub-agent), so this file is pure and
 * testable. The hard ceilings (4 tasks, 3 parallel) can be lowered, never raised.
 */

export const MAX_SWARM_TASKS = 4
export const MAX_SWARM_PARALLEL = 3

export interface RoleDef {
  kind: 'explore' | 'work'
  instructions: string
}

/** Roles the agent can name without any setup. */
export const BUILTIN_ROLES: Record<string, RoleDef> = {
  researcher: { kind: 'explore', instructions: 'You are the RESEARCHER. Find facts in the code and report them with file:line references. Change nothing.' },
  reviewer: { kind: 'explore', instructions: 'You are the REVIEWER. Look for bugs, risks and missing tests in what you are pointed at. Report concrete problems, most severe first. Change nothing.' },
  implementer: { kind: 'work', instructions: 'You are the IMPLEMENTER. Make the change you are asked for, only in the files named in your task, and say exactly which files you changed.' },
  tester: { kind: 'work', instructions: 'You are the TESTER. Write or run the tests your task names, report the real commands and their results, and fix only test files.' },
}

export interface SwarmLimits {
  /** Tasks per delegate call (1..4). */
  maxTasks: number
  /** Sub-agents running at the same time (1..3). */
  maxParallel: number
  /** Model calls the whole swarm may spend. The guard that still works when cost is unknown. */
  maxModelCalls: number
  /** Stop starting tasks once the KNOWN cost reaches this; null = no cost cap. */
  maxCostUsd: number | null
  /** Extra roles from the user's config. */
  roles: Record<string, RoleDef>
}

export const DEFAULT_SWARM: SwarmLimits = { maxTasks: MAX_SWARM_TASKS, maxParallel: MAX_SWARM_PARALLEL, maxModelCalls: 120, maxCostUsd: null, roles: {} }

const whole = (v: unknown, fallback: number, lo: number, hi: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.floor(v))) : fallback)

/** Whatever the config says, the limits stay inside the hard ceilings. */
export function clampLimits(raw: Partial<SwarmLimits> | undefined): SwarmLimits {
  const r = raw ?? {}
  return {
    maxTasks: whole(r.maxTasks, DEFAULT_SWARM.maxTasks, 1, MAX_SWARM_TASKS),
    maxParallel: whole(r.maxParallel, DEFAULT_SWARM.maxParallel, 1, MAX_SWARM_PARALLEL),
    maxModelCalls: whole(r.maxModelCalls, DEFAULT_SWARM.maxModelCalls, 1, 100_000),
    maxCostUsd: typeof r.maxCostUsd === 'number' && Number.isFinite(r.maxCostUsd) && r.maxCostUsd > 0 ? r.maxCostUsd : null,
    roles: r.roles ?? {},
  }
}

export interface SwarmTaskInput {
  id?: string
  title: string
  prompt: string
  kind?: 'explore' | 'work'
  role?: string
  dependsOn?: string[]
}

export interface SwarmTask {
  id: string
  title: string
  prompt: string
  kind: 'explore' | 'work'
  role?: string
  /** Role instructions to prepend to the sub-agent's prompt. */
  roleNote?: string
  dependsOn: string[]
}

export type PlanResult = { ok: true; tasks: SwarmTask[] } | { ok: false; error: string }

/** Validate a plan: ids, roles, dependencies, no cycles. The error is written for the model. */
export function planSwarm(inputs: SwarmTaskInput[], limits: SwarmLimits, opts: { readOnly?: boolean } = {}): PlanResult {
  if (!inputs.length) return { ok: false, error: 'The plan has no tasks.' }
  if (inputs.length > limits.maxTasks) return { ok: false, error: `A swarm may have at most ${limits.maxTasks} tasks; you sent ${inputs.length}. Merge or drop some.` }
  const roles = { ...BUILTIN_ROLES, ...limits.roles }
  const tasks: SwarmTask[] = inputs.map((x, i) => {
    const role = x.role?.trim() || undefined
    const def = role ? roles[role] : undefined
    const kind = opts.readOnly ? 'explore' : (x.kind ?? def?.kind ?? 'explore')
    return {
      id: (x.id?.trim() || `t${i + 1}`).slice(0, 24),
      title: x.title,
      prompt: x.prompt,
      kind,
      ...(role ? { role } : {}),
      ...(def ? { roleNote: def.instructions } : {}),
      dependsOn: [...new Set((x.dependsOn ?? []).map((d) => d.trim()).filter(Boolean))],
    }
  })
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) return { ok: false, error: `Duplicate task id "${t.id}". Ids must be unique.` }
    ids.add(t.id)
  }
  for (const t of tasks) {
    for (const d of t.dependsOn) {
      if (!ids.has(d)) return { ok: false, error: `Task "${t.id}" depends on unknown task "${d}".` }
      if (d === t.id) return { ok: false, error: `Task "${t.id}" cannot depend on itself (cycle).` }
    }
  }
  // A cycle is any set of tasks that can never become ready.
  const done = new Set<string>()
  for (let progressed = true; progressed; ) {
    progressed = false
    for (const t of tasks) if (!done.has(t.id) && t.dependsOn.every((d) => done.has(d))) (done.add(t.id), (progressed = true))
  }
  if (done.size !== tasks.length) return { ok: false, error: 'The dependencies form a cycle: some tasks could never start.' }
  return { ok: true, tasks }
}

export type TaskStatus = 'waiting' | 'running' | 'done' | 'failed' | 'skipped'

export interface TaskOutcome {
  report: string
  failed: boolean
  modelCalls: number
  /** null = unknown (never counted as zero). */
  costUsd: number | null
}

export interface TaskResult {
  task: SwarmTask
  status: Exclude<TaskStatus, 'waiting' | 'running'>
  report: string
  modelCalls: number
  costUsd: number | null
}

export interface SwarmRun {
  tasks: SwarmTask[]
  limits: SwarmLimits
  /** Run one task. `deps` are the reports of the tasks it depends on; `peers` is the shared task list. */
  run: (task: SwarmTask, ctx: { peers: string; deps: Record<string, string>; callsLeft: number }) => Promise<TaskOutcome>
  /** `outcome` is set when a task finishes (done / failed): its report, calls and cost. */
  onStatus?: (task: SwarmTask, status: TaskStatus, detail?: string, outcome?: TaskOutcome) => void
  /** Return a reason to stop starting tasks (the user cancelled the swarm); null to go on. */
  shouldStop?: () => string | null
}

/** The shared task list every sub-agent sees, so peers do not duplicate each other. */
export function peerList(tasks: SwarmTask[], me: SwarmTask): string {
  return tasks
    .map((t) => `- ${t.id}${t.id === me.id ? ' (you)' : ''}: ${t.title}${t.role ? ` [${t.role}]` : ''}${t.dependsOn.length ? ` — after ${t.dependsOn.join(', ')}` : ''}`)
    .join('\n')
}

export async function runSwarm(opts: SwarmRun): Promise<{ results: TaskResult[]; merged: string; modelCalls: number; costUsd: number | null }> {
  const { tasks, limits } = opts
  const results = new Map<string, TaskResult>()
  const running = new Map<string, Promise<void>>()
  let calls = 0
  let knownCost = 0
  let anyUnknown = false
  let anyCost = false
  for (const t of tasks) opts.onStatus?.(t, 'waiting')

  const finish = (task: SwarmTask, status: TaskResult['status'], report: string, o?: TaskOutcome): void => {
    results.set(task.id, { task, status, report, modelCalls: o?.modelCalls ?? 0, costUsd: o?.costUsd ?? null })
    opts.onStatus?.(task, status, status === 'skipped' ? report : undefined, o)
  }
  const budgetReason = (): string | null => {
    const stop = opts.shouldStop?.()
    if (stop) return stop
    if (calls >= limits.maxModelCalls) return `swarm budget spent (${calls} of ${limits.maxModelCalls} model calls)`
    if (limits.maxCostUsd !== null && anyCost && knownCost >= limits.maxCostUsd) return `swarm budget spent ($${knownCost.toFixed(4)} of $${limits.maxCostUsd})`
    return null
  }

  while (results.size < tasks.length) {
    for (const t of tasks) {
      if (results.has(t.id) || running.has(t.id)) continue
      const deps = t.dependsOn.map((d) => results.get(d))
      if (deps.some((d) => d && d.status !== 'done')) {
        finish(t, 'skipped', `a task it depends on did not finish (${t.dependsOn.filter((d) => results.get(d)?.status !== 'done').join(', ')})`)
        continue
      }
      if (deps.some((d) => !d)) continue // still waiting
      if (running.size >= limits.maxParallel) continue
      const why = budgetReason()
      if (why) {
        finish(t, 'skipped', why)
        continue
      }
      opts.onStatus?.(t, 'running')
      const depReports = Object.fromEntries(t.dependsOn.map((d) => [d, results.get(d)!.report]))
      const p = opts
        .run(t, { peers: peerList(tasks, t), deps: depReports, callsLeft: Math.max(1, limits.maxModelCalls - calls) })
        .then(
          (o) => {
            calls += o.modelCalls
            if (o.costUsd === null) anyUnknown = true
            else (anyCost = true, (knownCost += o.costUsd))
            finish(t, o.failed ? 'failed' : 'done', o.report, o)
          },
          (err: unknown) => finish(t, 'failed', `the sub-agent crashed: ${(err as Error).message}`),
        )
        .finally(() => running.delete(t.id))
      running.set(t.id, p)
    }
    if (results.size >= tasks.length) break
    if (running.size === 0) {
      // Nothing running and nothing startable: whatever is left can never run.
      for (const t of tasks) if (!results.has(t.id)) finish(t, 'skipped', 'it could not be scheduled')
      break
    }
    await Promise.race(running.values())
  }

  const ordered = tasks.map((t) => results.get(t.id)!)
  const costUsd = anyUnknown || !anyCost ? null : knownCost
  const count = (s: TaskResult['status']): number => ordered.filter((r) => r.status === s).length
  const head =
    `## Swarm result: ${count('done')} done, ${count('failed')} failed, ${count('skipped')} skipped · ${calls} model calls · ` +
    (costUsd === null ? (anyCost ? `cost unknown (at least $${knownCost.toFixed(4)})` : 'cost unknown') : `cost $${costUsd.toFixed(4)}`)
  const body = ordered.map((r) => `### ${r.task.id} · ${r.task.title}${r.task.role ? ` [${r.task.role}]` : ''} — ${r.status.toUpperCase()}\n${r.report.slice(0, 6000)}`)
  const changed = ordered.some((r) => r.status === 'done' && r.task.kind === 'work')
  const note = changed ? '\nSub-agents that edit files have finished: check their work (git diff, the tests) before you claim anything.' : ''
  return { results: ordered, merged: [head, ...body].join('\n\n') + note, modelCalls: calls, costUsd }
}
