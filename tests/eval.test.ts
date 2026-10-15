import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { runEval } from '../src/eval/command.js'
import { buildReport, renderMarkdown, verdict } from '../src/eval/report.js'
import { compare, materialise, runCheck, wilson, type RunResult } from '../src/eval/runner.js'
import { TASKS } from '../src/eval/tasks.js'
import { readFile, writeFile } from 'node:fs/promises'

describe('eval tasks', () => {
  it('has a useful number of uniquely named tasks', () => {
    expect(TASKS.length).toBeGreaterThanOrEqual(15)
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length)
  })

  // The guarantee that makes the whole harness meaningful: every task is broken to begin with and the reference edit really fixes it.
  for (const task of TASKS) {
    it(`${task.id}: fails before the reference solution and passes after it`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'vara-eval-test-'))
      try {
        await materialise(task, dir)
        const before = await runCheck(task.checkCommand, dir)
        expect(before.ok, 'the check must fail on the untouched fixture').toBe(false)
        for (const e of task.solution) {
          const file = join(dir, e.path)
          const text = await readFile(file, 'utf8')
          expect(text.split(e.oldString).length - 1, `${e.path}: oldString must match exactly once`).toBe(1)
          await writeFile(file, text.replace(e.oldString, () => e.newString), 'utf8')
        }
        const after = await runCheck(task.checkCommand, dir)
        expect(after.ok, after.tail).toBe(true)
      } finally {
        await rm(dir, { recursive: true, force: true })
      }
    }, 30_000)
  }
})

const run = (over: Partial<RunResult>): RunResult => ({
  taskId: 't1',
  arm: 'on',
  model: 'm',
  repeat: 1,
  passed: true,
  state: 'completed',
  turns: 5,
  modelCalls: 5,
  inputTokens: 1000,
  cachedInputTokens: 0,
  outputTokens: 100,
  totalTokens: 1100,
  limitUnits: 1100,
  costUsd: 0.01,
  costPartial: false,
  elapsedMs: 1000,
  checkTail: '',
  ...over,
})

describe('eval comparison', () => {
  it('computes savings and quality delta, and flags a task the cost engine lost', () => {
    const rs = [
      run({ arm: 'off', taskId: 'a', totalTokens: 2000, limitUnits: 2000, costUsd: 0.02 }),
      run({ arm: 'on', taskId: 'a', totalTokens: 1000, limitUnits: 1000, costUsd: 0.01 }),
      run({ arm: 'off', taskId: 'b' }),
      run({ arm: 'on', taskId: 'b', passed: false }),
    ]
    const c = compare('m', rs)
    expect(c.qualityDeltaPoints).toBe(-50)
    expect(c.regressions).toEqual(['b'])
    expect(c.solvedBoth.tasks).toBe(1)
    expect(c.solvedBoth.tokensSavedPercent).toBe(50)
    expect(verdict(c)).toContain('Do not treat this configuration as lossless')
  })

  it('keeps unknown cost unknown: one unpriced run makes the total null, never a partial sum', () => {
    const rs = [run({ arm: 'off', costUsd: 0.02 }), run({ arm: 'on', costUsd: null }), run({ arm: 'off', taskId: 't2', costUsd: 0.02 }), run({ arm: 'on', taskId: 't2', costUsd: 0.01 })]
    const c = compare('m', rs)
    expect(c.on.costUsd).toBeNull()
    expect(c.costSavedPercent).toBeNull()
    expect(c.off.costUsd).toBeCloseTo(0.04)
  })

  it('wilson interval brackets the rate and widens for small samples', () => {
    const [lo, hi] = wilson(19, 19)
    expect(hi).toBe(1)
    expect(lo).toBeGreaterThan(0.8)
    expect(lo).toBeLessThan(1)
    expect(wilson(0, 0)).toEqual([0, 0])
    expect(wilson(5, 10)[1] - wilson(5, 10)[0]).toBeGreaterThan(wilson(50, 100)[1] - wilson(50, 100)[0])
  })
})

describe('eval offline run (scripted model, no network)', () => {
  it('solves the chosen tasks in both arms, compresses the noisy output only when ON, and writes an honest report', async () => {
    const tasks = TASKS.filter((t) => ['sum-off-by-one', 'rename-across-files', 'noisy-test-output'].includes(t.id))
    expect(tasks).toHaveLength(3)
    const report = await runEval({ tasks, models: ['claude-3-5-sonnet'], arms: ['on', 'off'], repeat: 1 })
    expect(report.mode).toBe('offline-scripted')
    expect(report.results).toHaveLength(6)
    for (const r of report.results) expect(r.passed, `${r.taskId} ${r.arm}: ${r.checkTail}`).toBe(true)
    const c = report.comparisons[0]!
    expect(c.qualityDeltaPoints).toBe(0)
    expect(c.regressions).toEqual([])
    const by = (id: string, arm: 'on' | 'off') => report.results.find((r) => r.taskId === id && r.arm === arm)!
    // A 600-line noisy test run is where the engine has something to cut; a tiny task has nothing to cut and must not be made worse.
    expect(by('noisy-test-output', 'on').limitUnits!).toBeLessThan(by('noisy-test-output', 'off').limitUnits! * 0.8)
    expect(by('sum-off-by-one', 'on').limitUnits!).toBeLessThanOrEqual(by('sum-off-by-one', 'off').limitUnits! * 1.02)
    const md = renderMarkdown(report)
    expect(md).toContain('no real model was called')
    expect(md).toContain('NOT evidence about how a real model behaves')
    expect(report.limits.some((l) => l.startsWith('OFFLINE'))).toBe(true)
  }, 120_000)

  it('a live report carries the live caveats, not the offline ones', () => {
    const r = buildReport({ version: 'x', generatedAt: 'now', mode: 'live', provider: 'p', models: ['m'], tasks: ['t1'], repeats: 1, onArm: 'on', offArm: 'off', results: [run({ arm: 'on' }), run({ arm: 'off' })] })
    expect(r.limits.some((l) => l.startsWith('LIVE'))).toBe(true)
    expect(r.limits.some((l) => l.startsWith('OFFLINE'))).toBe(false)
  })
})
