import { compare, type Comparison, type RunResult } from './runner.js'

export interface EvalReport {
  schema: 1
  version: string
  generatedAt: string
  /** 'offline-scripted': a fixed script stands in for the model, tokens are simulated sizes. 'live': a real provider was called. */
  mode: 'offline-scripted' | 'live'
  provider: string | null
  models: string[]
  tasks: string[]
  repeats: number
  /** What the ON arm switched on (so the claim is attached to a configuration). */
  onArm: string
  offArm: string
  results: RunResult[]
  comparisons: Comparison[]
  /** What this report does and does not show. */
  limits: string[]
}

export function buildReport(input: Omit<EvalReport, 'schema' | 'comparisons' | 'limits'>): EvalReport {
  return {
    schema: 1,
    ...input,
    comparisons: input.models.map((m) => compare(m, input.results)),
    limits: limitsFor(input.mode, input.tasks.length, input.repeats),
  }
}

export function limitsFor(mode: EvalReport['mode'], tasks: number, repeats: number): string[] {
  const common = [
    `${tasks} small tasks x ${repeats} repetition(s) is a small sample: it can show a large quality loss, it cannot rule out a small one (see the confidence intervals).`,
    'The tasks are small single-bug / single-feature JavaScript projects. They say nothing about large codebases, other languages, or long multi-hour sessions.',
    'Pass/fail is decided by the runner executing the task\'s check command after the agent stops; the agent\'s own claim is not trusted.',
  ]
  if (mode === 'offline-scripted')
    return [
      'OFFLINE: no model was called. A fixed script replays the same reference solution in both arms, so the pass rate only proves that the fixtures are solvable and that the cost engine does not corrupt tool results or edits. It is NOT evidence about how a real model behaves with the cost engine on.',
      'OFFLINE: token counts are the sizes of what VARA sent (about 4 characters per token) and the provider cache is simulated; costs use the price table in src/llm/registry.ts. Savings here measure what the engine sends for an identical conversation, not what a provider would bill.',
      ...common,
    ]
  return [
    'LIVE: a real model was called. Models are not deterministic: one run per task is noisy, so repeat (--repeat) before drawing conclusions. Token and cost figures are what the provider reported (null/unknown when it did not; unknown is never counted as zero).',
    'Savings are only comparable between arms of the same model on the same tasks; the ON arm used the routing the configuration defines, so changing the router changes the result.',
    ...common,
  ]
}

const pct = (n: number | null, digits = 1): string => (n === null ? 'unknown' : `${n.toFixed(digits)}%`)
const pp = (n: number): string => `${n > 0 ? '+' : ''}${n.toFixed(1)} points`
const k = (n: number | null): string => (n === null ? 'unknown' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const usd = (n: number | null): string => (n === null ? 'unknown' : `$${n.toFixed(4)}`)
const sec = (ms: number): string => `${(ms / 1000).toFixed(1)}s`
const change = (n: number | null, better: string, worse: string): string => (n === null ? 'unknown' : Math.abs(n) < 0.05 ? 'same' : `${n >= 0 ? better : worse} ${pct(Math.abs(n))}`)
const ci = (c: [number, number]): string => `${(c[0] * 100).toFixed(0)}–${(c[1] * 100).toFixed(0)}%`

/** A one-sentence verdict that never claims more than the data supports. */
export function verdict(c: Comparison): string {
  const n = c.on.runs
  if (c.regressions.length)
    return `Quality: ${c.regressions.length} task(s) solved with the cost engine OFF were not solved with it ON (${c.regressions.join(', ')}). Do not treat this configuration as lossless.`
  const base = `No task that OFF solved was lost with the cost engine ON (${c.on.passed}/${n} vs ${c.off.passed}/${c.off.runs} runs passed; 95% interval for ON ${ci(c.on.passRateCi)})`
  const s = c.limitUnitsSavedPercent ?? c.tokensSavedPercent
  return s === null ? `${base}; savings could not be computed (usage unknown).` : `${base}; limit units ${s >= 0 ? 'saved' : 'added'} ${pct(Math.abs(s))} over all runs.`
}

export function renderMarkdown(r: EvalReport): string {
  const L: string[] = []
  L.push(`# VARA eval report`)
  L.push('')
  L.push(`- Version: ${r.version} · generated ${r.generatedAt}`)
  L.push(`- Mode: **${r.mode === 'live' ? `live (${r.provider ?? 'provider'})` : 'offline, scripted model — no real model was called'}**`)
  L.push(`- Tasks: ${r.tasks.length} · repetitions: ${r.repeats} · models: ${r.models.join(', ')}`)
  L.push(`- ON arm: ${r.onArm}`)
  L.push(`- OFF arm: ${r.offArm}`)
  L.push('')
  for (const c of r.comparisons) {
    L.push(`## Model: ${c.model}`)
    L.push('')
    L.push(verdict(c))
    L.push('')
    L.push('| | cost engine OFF | cost engine ON | change |')
    L.push('| --- | ---: | ---: | ---: |')
    L.push(`| runs passed | ${c.off.passed}/${c.off.runs} (${(c.off.passRate * 100).toFixed(0)}%, 95% CI ${ci(c.off.passRateCi)}) | ${c.on.passed}/${c.on.runs} (${(c.on.passRate * 100).toFixed(0)}%, 95% CI ${ci(c.on.passRateCi)}) | quality ${pp(c.qualityDeltaPoints)} |`)
    L.push(`| tokens (input + cached + output) | ${k(c.off.totalTokens)} | ${k(c.on.totalTokens)} | ${c.tokensSavedPercent === null ? 'unknown' : `saved ${pct(c.tokensSavedPercent)}`} |`)
    L.push(`| limit units* | ${k(c.off.limitUnits)} | ${k(c.on.limitUnits)} | ${c.limitUnitsSavedPercent === null ? 'unknown' : `saved ${pct(c.limitUnitsSavedPercent)}`} |`)
    L.push(`| cost (USD) | ${usd(c.off.costUsd)} | ${usd(c.on.costUsd)} | ${c.costSavedPercent === null ? 'unknown' : `saved ${pct(c.costSavedPercent)}`} |`)
    L.push(`| model calls | ${c.off.modelCalls} | ${c.on.modelCalls} | |`)
    L.push(`| agent turns | ${c.off.turns} | ${c.on.turns} | ${change(c.turnsDeltaPercent, 'fewer', 'more')} |`)
    L.push(`| wall time | ${sec(c.off.elapsedMs)} | ${sec(c.on.elapsedMs)} | ${change(c.elapsedDeltaPercent, 'faster', 'slower')} |`)
    L.push('')
    L.push('\\*limit units = uncached input + 0.1 × cached input + output (what a usage limit counts).')
    L.push('')
    L.push(
      `Over the ${c.solvedBoth.tasks} task(s) both arms solved (a fair comparison: an arm that fails early is not "cheaper"): tokens saved ${pct(c.solvedBoth.tokensSavedPercent)}, limit units saved ${pct(c.solvedBoth.limitUnitsSavedPercent)}, cost saved ${pct(c.solvedBoth.costSavedPercent)}.`,
    )
    L.push('')
    if (c.regressions.length) L.push(`**Regressions (OFF solved, ON did not):** ${c.regressions.join(', ')}`, '')
    if (c.gains.length) L.push(`Gains (ON solved, OFF did not): ${c.gains.join(', ')}`, '')
  }
  L.push('## Per task')
  L.push('')
  L.push('| task | model | OFF pass | ON pass | OFF limit units | ON limit units | OFF calls | ON calls |')
  L.push('| --- | --- | :-: | :-: | ---: | ---: | ---: | ---: |')
  for (const model of r.models) {
    for (const id of r.tasks) {
      const pick = (arm: 'on' | 'off') => r.results.filter((x) => x.taskId === id && x.model === model && x.arm === arm)
      const off = pick('off')
      const on = pick('on')
      const passes = (rs: RunResult[]) => (rs.length ? `${rs.filter((x) => x.passed).length}/${rs.length}` : '-')
      const mean = (rs: RunResult[], f: (x: RunResult) => number | null) => {
        const vals = rs.map(f)
        return vals.length && vals.every((v) => v !== null) ? (vals as number[]).reduce((a, b) => a + b, 0) / vals.length : null
      }
      L.push(`| ${id} | ${model} | ${passes(off)} | ${passes(on)} | ${k(mean(off, (x) => x.limitUnits))} | ${k(mean(on, (x) => x.limitUnits))} | ${mean(off, (x) => x.modelCalls)?.toFixed(1) ?? '-'} | ${mean(on, (x) => x.modelCalls)?.toFixed(1) ?? '-'} |`)
    }
  }
  L.push('')
  const failed = r.results.filter((x) => !x.passed)
  if (failed.length) {
    L.push('## Failed runs')
    L.push('')
    for (const f of failed.slice(0, 20)) L.push(`- ${f.taskId} (${f.arm}, ${f.model}, repeat ${f.repeat}): state ${f.state}${f.error ? ` — ${f.error.slice(0, 160)}` : ''}`)
    if (failed.length > 20) L.push(`- … ${failed.length - 20} more (see the JSON)`)
    L.push('')
  }
  L.push('## What this does and does not show')
  L.push('')
  for (const l of r.limits) L.push(`- ${l}`)
  L.push('')
  return L.join('\n')
}
