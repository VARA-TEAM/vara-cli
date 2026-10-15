import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DEFAULT_CONFIG } from '../config/config.js'
import { Engine } from '../core/engine.js'
import { createSession, CreateSessionInput } from '../core/session.js'
import type { RouterSettings } from '../core/router.js'
import { UsageMeter } from '../core/usage-meter.js'
import type { Provider } from '../llm/provider.js'
import { scriptedProvider } from './scripted.js'
import type { EvalTask } from './tasks.js'

export type ArmId = 'on' | 'off'

/** One task, one arm, one model, one repetition. Unknown stays null — never 0. */
export interface RunResult {
  taskId: string
  arm: ArmId
  model: string
  repeat: number
  /** The runner's OWN execution of the check command after the agent stopped; the agent's claim does not count. */
  passed: boolean
  /** Session state at the end (completed, failed, budget_exhausted, ...). */
  state: string
  turns: number
  modelCalls: number
  inputTokens: number | null
  cachedInputTokens: number | null
  outputTokens: number | null
  /** input + cached + output; null when any part is unknown. */
  totalTokens: number | null
  /** What a usage limit counts: uncached input + 0.1 x cached input + output. */
  limitUnits: number | null
  costUsd: number | null
  costPartial: boolean
  elapsedMs: number
  /** Last lines of the check output (so a failure can be understood from the report). */
  checkTail: string
  error?: string
}

export interface ArmSettings {
  /** Cost-engine switches for the ON arm. */
  summarize: boolean
  toolOutputChars: number
  smartRead: boolean
}

export const COST_ON: ArmSettings = { summarize: true, toolOutputChars: 3000, smartRead: true }

export interface RunOptions {
  task: EvalTask
  arm: ArmId
  model: string
  repeat: number
  /** The provider to call. Offline runs pass nothing and use the scripted model. */
  provider?: Provider
  /** Router settings for the ON arm (the user's own routing; absent = no routing). */
  router?: () => RouterSettings
  maxTurns: number
  maxModelCalls: number
  /** Wall-clock budget per run. */
  maxMs: number
}

/** Writes a task's fixture project into `dir`. */
export async function materialise(task: EvalTask, dir: string): Promise<void> {
  for (const [rel, content] of Object.entries(task.files)) {
    const target = join(dir, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
}

/** Runs the check command and returns its verdict and last lines. */
export function runCheck(command: string, cwd: string, timeoutMs = 60_000): Promise<{ ok: boolean; tail: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true })
    let out = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d: Buffer) => (out += d.toString()))
    child.stderr.on('data', (d: Buffer) => (out += d.toString()))
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, tail: String(err.message) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, tail: out.trim().split('\n').slice(-6).join('\n').slice(-600) })
    })
  })
}

const sumKnown = (xs: Array<number | null>): number | null => (xs.some((x) => x === null) ? null : xs.reduce<number>((a, b) => a + (b ?? 0), 0))

export async function runOne(opts: RunOptions): Promise<RunResult> {
  const { task } = opts
  const dir = await mkdtemp(join(tmpdir(), `vara-eval-${task.id}-`))
  const meterDir = await mkdtemp(join(tmpdir(), 'vara-eval-meter-'))
  const started = Date.now()
  let state = 'error'
  let error: string | undefined
  let session: ReturnType<typeof createSession> | undefined
  try {
    await materialise(task, dir)
    session = createSession(
      CreateSessionInput.parse({ objective: task.objective, cwd: dir, kind: 'task', model: opts.model, verifyCommand: task.checkCommand }),
      DEFAULT_CONFIG,
    )
    session.config.budget = { maxTurns: opts.maxTurns, maxDurationMs: opts.maxMs, maxModelCalls: opts.maxModelCalls }
    const provider = opts.provider ?? scriptedProvider(task)
    const meter = new UsageMeter(join(meterDir, 'usage.jsonl'))
    const on = opts.arm === 'on'
    const engine = new Engine({
      session,
      provider,
      model: opts.model,
      ephemeral: true,
      interactive: false,
      ...(on ? { meter, costSettings: () => COST_ON, ...(opts.router ? { router: opts.router } : {}) } : {}),
    })
    await engine.run()
    await meter.flush()
    state = session.state
    if (session.state === 'failed' && session.stateReason) error = session.stateReason
  } catch (err) {
    error = (err as Error).message
  }
  const elapsedMs = Date.now() - started
  // The verdict is the runner's own: run the check on whatever the agent left behind.
  const verdict = await runCheck(task.checkCommand, dir)
  await rm(dir, { recursive: true, force: true }).catch(() => {})
  await rm(meterDir, { recursive: true, force: true }).catch(() => {})

  const u = session?.usage
  const input = u?.inputTokens ?? null
  const cached = u?.cachedInputTokens ?? null
  const output = u?.outputTokens ?? null
  // Cached tokens unreported = the provider has no cache concept: treat as 0 for the sums, but only when input was reported.
  const total = input === null || output === null ? null : input + (cached ?? 0) + output
  const limitUnits = input === null || output === null ? null : input + 0.1 * (cached ?? 0) + output
  return {
    taskId: task.id,
    arm: opts.arm,
    model: opts.model,
    repeat: opts.repeat,
    passed: verdict.ok,
    state,
    turns: u?.turns ?? 0,
    modelCalls: session?.modelCalls?.length ?? 0,
    inputTokens: input,
    cachedInputTokens: cached,
    outputTokens: output,
    totalTokens: total,
    limitUnits,
    costUsd: u?.costUsd ?? null,
    costPartial: u?.costPartial ?? false,
    elapsedMs,
    checkTail: verdict.tail,
    ...(error ? { error } : {}),
  }
}

/* ------------------------------------------------------------------ */
/* Aggregation                                                         */
/* ------------------------------------------------------------------ */

export interface ArmSummary {
  arm: ArmId
  runs: number
  passed: number
  passRate: number
  /** 95% Wilson score interval for the pass rate. */
  passRateCi: [number, number]
  /** Sums over runs; null when any run has no figure (never a partial sum presented as complete). */
  totalTokens: number | null
  limitUnits: number | null
  costUsd: number | null
  turns: number
  modelCalls: number
  elapsedMs: number
}

export interface Comparison {
  model: string
  on: ArmSummary
  off: ArmSummary
  /** On minus off, in percentage points (positive = ON passes more). */
  qualityDeltaPoints: number
  /** (off - on) / off * 100 over ALL runs. null when a figure is unknown. */
  tokensSavedPercent: number | null
  limitUnitsSavedPercent: number | null
  costSavedPercent: number | null
  /** The same, over runs of tasks BOTH arms solved (a fair comparison: a failing arm that stopped early is not "cheaper"). */
  solvedBoth: { tasks: number; tokensSavedPercent: number | null; limitUnitsSavedPercent: number | null; costSavedPercent: number | null }
  /** Tasks the OFF arm solved (in every repetition) and the ON arm did not. */
  regressions: string[]
  /** Tasks the ON arm solved and OFF did not. */
  gains: string[]
  turnsDeltaPercent: number | null
  elapsedDeltaPercent: number | null
}

export function wilson(passed: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0]
  const p = passed / n
  const denom = 1 + (z * z) / n
  const centre = (p + (z * z) / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom
  return [Math.max(0, centre - half), Math.min(1, centre + half)]
}

export function summarise(arm: ArmId, rs: RunResult[]): ArmSummary {
  const passed = rs.filter((r) => r.passed).length
  return {
    arm,
    runs: rs.length,
    passed,
    passRate: rs.length ? passed / rs.length : 0,
    passRateCi: wilson(passed, rs.length),
    totalTokens: sumKnown(rs.map((r) => r.totalTokens)),
    limitUnits: sumKnown(rs.map((r) => r.limitUnits)),
    costUsd: sumKnown(rs.map((r) => r.costUsd)),
    turns: rs.reduce((n, r) => n + r.turns, 0),
    modelCalls: rs.reduce((n, r) => n + r.modelCalls, 0),
    elapsedMs: rs.reduce((n, r) => n + r.elapsedMs, 0),
  }
}

const saved = (off: number | null, on: number | null): number | null => (off === null || on === null || off <= 0 ? null : ((off - on) / off) * 100)

export function compare(model: string, results: RunResult[]): Comparison {
  const mine = results.filter((r) => r.model === model)
  const onRuns = mine.filter((r) => r.arm === 'on')
  const offRuns = mine.filter((r) => r.arm === 'off')
  const on = summarise('on', onRuns)
  const off = summarise('off', offRuns)

  const solvedAll = (rs: RunResult[], id: string): boolean => {
    const own = rs.filter((r) => r.taskId === id)
    return own.length > 0 && own.every((r) => r.passed)
  }
  const ids = [...new Set(mine.map((r) => r.taskId))]
  const both = ids.filter((id) => solvedAll(onRuns, id) && solvedAll(offRuns, id))
  const pick = (rs: RunResult[]) => summarise('on', rs.filter((r) => both.includes(r.taskId)))
  const bothOn = pick(onRuns)
  const bothOff = pick(offRuns)

  return {
    model,
    on,
    off,
    qualityDeltaPoints: (on.passRate - off.passRate) * 100,
    tokensSavedPercent: saved(off.totalTokens, on.totalTokens),
    limitUnitsSavedPercent: saved(off.limitUnits, on.limitUnits),
    costSavedPercent: saved(off.costUsd, on.costUsd),
    solvedBoth: {
      tasks: both.length,
      tokensSavedPercent: saved(bothOff.totalTokens, bothOn.totalTokens),
      limitUnitsSavedPercent: saved(bothOff.limitUnits, bothOn.limitUnits),
      costSavedPercent: saved(bothOff.costUsd, bothOn.costUsd),
    },
    regressions: ids.filter((id) => solvedAll(offRuns, id) && !solvedAll(onRuns, id)),
    gains: ids.filter((id) => solvedAll(onRuns, id) && !solvedAll(offRuns, id)),
    turnsDeltaPercent: saved(off.turns || null, on.turns),
    elapsedDeltaPercent: saved(off.elapsedMs || null, on.elapsedMs),
  }
}
