import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { loadConfig } from '../config/config.js'
import { activate, defaultModelFor } from '../config/providers.js'
import { routerFromConfig } from '../core/cost-wiring.js'
import type { RouterSettings } from '../core/router.js'
import type { Provider } from '../llm/provider.js'
import { buildProvider } from '../runtime.js'
import { VERSION } from '../version.js'
import { buildReport, renderMarkdown, type EvalReport } from './report.js'
import { runOne, COST_ON, type ArmId, type RunResult } from './runner.js'
import { OFFLINE_MODEL } from './scripted.js'
import { TASKS, type EvalTask } from './tasks.js'

export const EVAL_USAGE = `vara eval — measure what the cost engine saves AND whether quality holds.

Usage:
  vara eval --offline [--tasks a,b] [--repeat N] [--out DIR]
      scripted model, no network, no cost: proves the harness and the fixtures (CI uses this)
  vara eval --provider <name> [--model a,b] [--tasks a,b] [--repeat N] [--arms on,off] [--yes] [--out DIR]
      calls the real provider for every task x arm x model x repeat (this spends money: add --yes)
  vara eval --list                     list the tasks

Each task is a tiny project with an automated check. Every run happens in a fresh temp directory; the runner
executes the check itself after the agent stops. ON = the cost engine (output compression, summaries, smart reads,
and your routing config); OFF = the plain agent loop. Writes results.json and report.md to --out
(default ./vara-eval/<timestamp>).`

export interface EvalOptions {
  tasks: EvalTask[]
  models: string[]
  arms: ArmId[]
  repeat: number
  /** Real provider for a model, or undefined for the offline scripted model. */
  providerFor?: (model: string) => Provider
  router?: () => RouterSettings
  maxTurns?: number
  maxModelCalls?: number
  maxMs?: number
  providerName?: string | null
  onProgress?: (r: RunResult, done: number, total: number) => void
}

/** Runs the whole matrix sequentially (parallel runs would distort wall time and rate limits). */
export async function runEval(o: EvalOptions): Promise<EvalReport> {
  const results: RunResult[] = []
  const total = o.models.length * o.tasks.length * o.arms.length * o.repeat
  for (const model of o.models) {
    const provider = o.providerFor?.(model)
    for (let repeat = 1; repeat <= o.repeat; repeat++) {
      for (const task of o.tasks) {
        // Alternate which arm goes first, so a warm cache or a slow minute does not always favour one arm.
        const order = (task.id.length + repeat) % 2 === 0 ? o.arms : [...o.arms].reverse()
        for (const arm of order) {
          const r = await runOne({
            task,
            arm,
            model,
            repeat,
            ...(provider ? { provider } : {}),
            ...(o.router && arm === 'on' ? { router: o.router } : {}),
            maxTurns: o.maxTurns ?? 30,
            maxModelCalls: o.maxModelCalls ?? 80,
            maxMs: o.maxMs ?? 600_000,
          })
          results.push(r)
          o.onProgress?.(r, results.length, total)
        }
      }
    }
  }
  const live = !!o.providerFor
  const router = o.router?.()
  const routing = router?.enabled ? `, routing (${Object.keys(router.tiers).join('/') || 'no tiers set'}, floor ${router.floor})` : ', no routing'
  return buildReport({
    version: VERSION,
    generatedAt: new Date().toISOString(),
    mode: live ? 'live' : 'offline-scripted',
    provider: live ? (o.providerName ?? null) : null,
    models: o.models,
    tasks: o.tasks.map((t) => t.id),
    repeats: o.repeat,
    onArm: `cost engine on: output compression (${COST_ON.toolOutputChars} chars), summaries of old turns, smart reads of long files, identical-output pointers, verification reuse, loop stop${routing}`,
    offArm: 'plain agent loop: no cost engine (the v0.4.0 behaviour); prompt caching and compaction that always existed still apply',
    results,
  })
}

const flagOf = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

export async function evalCommand(args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(EVAL_USAGE)
    return
  }
  if (args.includes('--list')) {
    for (const t of TASKS) console.log(`${t.id.padEnd(24)} [${t.category}]  ${t.title}`)
    return
  }
  const offline = args.includes('--offline')
  const providerName = flagOf(args, '--provider')
  if (!offline && !providerName) return die('Choose --offline (no model) or --provider <name>. See: vara eval --help')
  if (offline && providerName) return die('--offline and --provider cannot be combined.')

  const wanted = flagOf(args, '--tasks')?.split(',').map((s) => s.trim()).filter(Boolean)
  const tasks = wanted ? TASKS.filter((t) => wanted.includes(t.id)) : TASKS
  if (wanted) {
    const unknown = wanted.filter((id) => !TASKS.some((t) => t.id === id))
    if (unknown.length) return die(`Unknown task(s): ${unknown.join(', ')}. See: vara eval --list`)
  }
  const repeat = Math.max(1, Number(flagOf(args, '--repeat') ?? '1') || 1)
  const armArg = (flagOf(args, '--arms') ?? 'on,off').split(',').map((s) => s.trim())
  const arms = armArg.filter((a): a is ArmId => a === 'on' || a === 'off')
  if (!arms.length || arms.length !== armArg.length) return die('--arms takes on, off or on,off')

  const opts: Partial<EvalOptions> = {}
  let models = [OFFLINE_MODEL]
  if (providerName) {
    let config = await loadConfig()
    const entry = config.providers[providerName]
    if (!entry) return die(`Unknown provider "${providerName}". Known: ${Object.keys(config.providers).join(', ') || 'none'} — see: vara providers`)
    models = (flagOf(args, '--model') ?? defaultModelFor(entry) ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (!models.length) return die(`Provider "${providerName}" has no models yet — run: vara setup, or pass --model`)
    const runs = models.length * tasks.length * arms.length * repeat
    if (!args.includes('--yes')) {
      return die(
        `This would make real model calls: ${runs} runs (${models.length} model(s) x ${tasks.length} task(s) x ${arms.length} arm(s) x ${repeat} repetition(s)), each up to ~30 turns, and it spends your provider credit.\nRun it again with --yes to go ahead (try --tasks sum-off-by-one first to see the cost of one task).`,
      )
    }
    const base = config
    const built = new Map<string, Provider>()
    opts.providerFor = (model) => {
      const hit = built.get(model)
      if (hit) return hit
      throw new Error(`provider for ${model} was not prepared`)
    }
    for (const m of models) {
      config = activate(base, providerName, m)
      built.set(m, (await buildProvider(config)).provider)
    }
    opts.router = () => routerFromConfig(base)
    opts.providerName = providerName
  }

  const total = models.length * tasks.length * arms.length * repeat
  console.log(`${offline ? 'Offline (scripted model, no network)' : `Live on ${providerName}`}: ${total} run(s)…`)
  const report = await runEval({
    tasks,
    models,
    arms,
    repeat,
    ...opts,
    onProgress: (r, done) => console.log(`  [${done}/${total}] ${r.taskId} ${r.arm.toUpperCase().padEnd(3)} ${r.passed ? 'pass' : 'FAIL'}  ${r.modelCalls} call(s)  ${r.limitUnits === null ? 'tokens unknown' : `${Math.round(r.limitUnits)} units`}`),
  })

  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  const dir = resolve(flagOf(args, '--out') ?? join('vara-eval', stamp))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'results.json'), JSON.stringify(report, null, 2) + '\n', 'utf8')
  const md = renderMarkdown(report)
  await writeFile(join(dir, 'report.md'), md, 'utf8')
  console.log(`\n${md}\nWrote ${join(dir, 'results.json')} and ${join(dir, 'report.md')}`)
  // A lost task is a failed evaluation: CI can rely on the exit code.
  if (report.comparisons.some((c) => c.regressions.length) || (offline && report.results.some((r) => !r.passed))) process.exitCode = 1
}

function die(message: string): void {
  console.error(message)
  process.exitCode = 1
}
