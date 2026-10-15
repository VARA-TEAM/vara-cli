import { describe, expect, it } from 'vitest'
import { BUILTIN_ROLES, clampLimits, DEFAULT_SWARM, planSwarm, runSwarm, type SwarmLimits, type TaskOutcome } from '../src/core/swarm.js'

const limits = (over: Partial<SwarmLimits> = {}): SwarmLimits => ({ ...DEFAULT_SWARM, ...over })
const t = (title: string, extra: Record<string, unknown> = {}) => ({ title, prompt: `do ${title} carefully`, ...extra })
const ok = (report = 'fine', over: Partial<TaskOutcome> = {}): TaskOutcome => ({ report, failed: false, modelCalls: 2, costUsd: 0.01, ...over })

describe('limits can only be lowered', () => {
  it('clamps to the hard ceilings (4 tasks, 3 parallel) and keeps lower values', () => {
    expect(clampLimits({ maxTasks: 99, maxParallel: 99 })).toMatchObject({ maxTasks: 4, maxParallel: 3 })
    expect(clampLimits({ maxTasks: 2, maxParallel: 1 })).toMatchObject({ maxTasks: 2, maxParallel: 1 })
    expect(clampLimits({ maxTasks: 0, maxParallel: -3, maxModelCalls: 0 })).toMatchObject({ maxTasks: 1, maxParallel: 1, maxModelCalls: 1 })
    expect(clampLimits({})).toEqual(DEFAULT_SWARM)
  })
})

describe('planSwarm', () => {
  it('gives ids, resolves roles to a kind and adds role instructions', () => {
    const r = planSwarm([t('scan', { role: 'researcher' }), t('fix', { role: 'implementer' }), t('plain')], limits())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.tasks.map((x) => [x.id, x.kind, x.role])).toEqual([
      ['t1', 'explore', 'researcher'],
      ['t2', 'work', 'implementer'],
      ['t3', 'explore', undefined],
    ])
    expect(BUILTIN_ROLES['reviewer']!.kind).toBe('explore')
  })

  it('an explicit kind beats the role, a custom role from the limits is known', () => {
    const custom = limits({ roles: { docs: { kind: 'work', instructions: 'write docs only' } } })
    const r = planSwarm([t('x', { role: 'docs', kind: 'explore' })], custom)
    expect(r.ok && r.tasks[0]!.kind).toBe('explore')
    const r2 = planSwarm([t('x', { role: 'docs' })], custom)
    expect(r2.ok && r2.tasks[0]!.kind).toBe('work')
  })

  it('rejects too many tasks, duplicate ids, unknown or cyclic dependencies, with a reason the model can act on', () => {
    expect(planSwarm([t('a'), t('b'), t('c')], limits({ maxTasks: 2 }))).toMatchObject({ ok: false, error: expect.stringMatching(/at most 2/) })
    expect(planSwarm([t('a', { id: 'x' }), t('b', { id: 'x' })], limits())).toMatchObject({ ok: false, error: expect.stringMatching(/duplicate/i) })
    expect(planSwarm([t('a', { id: 'a', dependsOn: ['zzz'] })], limits())).toMatchObject({ ok: false, error: expect.stringMatching(/unknown task "zzz"/) })
    expect(planSwarm([t('a', { id: 'a', dependsOn: ['b'] }), t('b', { id: 'b', dependsOn: ['a'] })], limits())).toMatchObject({ ok: false, error: expect.stringMatching(/cycle/i) })
    expect(planSwarm([t('a', { id: 'a', dependsOn: ['a'] })], limits())).toMatchObject({ ok: false })
    expect(planSwarm([], limits())).toMatchObject({ ok: false })
  })

  it('a plan-mode parent turns every task read-only', () => {
    const r = planSwarm([t('fix', { role: 'implementer', kind: 'work' })], limits(), { readOnly: true })
    expect(r.ok && r.tasks[0]!.kind).toBe('explore')
  })
})

describe('runSwarm', () => {
  const plan = (inputs: Array<ReturnType<typeof t>>, l = limits()) => {
    const r = planSwarm(inputs, l)
    if (!r.ok) throw new Error(r.error)
    return r.tasks
  }

  it('never runs more than maxParallel at once and merges every report in plan order', async () => {
    let live = 0
    let peak = 0
    const res = await runSwarm({
      tasks: plan([t('a'), t('b'), t('c'), t('d')]),
      limits: limits({ maxParallel: 2 }),
      run: async (task) => {
        live++
        peak = Math.max(peak, live)
        await new Promise((r) => setTimeout(r, 15))
        live--
        return ok(`report of ${task.title}`)
      },
    })
    expect(peak).toBe(2)
    expect(res.merged.indexOf('report of a')).toBeLessThan(res.merged.indexOf('report of d'))
    expect(res.merged).toMatch(/4 done/)
    expect(res.modelCalls).toBe(8)
  })

  it('runs a task only after its dependencies and hands it their reports', async () => {
    const order: string[] = []
    let seen: Record<string, string> = {}
    await runSwarm({
      tasks: plan([t('write', { id: 'w', dependsOn: ['r'] }), t('research', { id: 'r' })]),
      limits: limits(),
      run: async (task, ctx) => {
        order.push(task.id)
        if (task.id === 'w') seen = ctx.deps
        return ok(`out-${task.id}`)
      },
    })
    expect(order).toEqual(['r', 'w'])
    expect(seen).toEqual({ r: 'out-r' })
  })

  it('a failed dependency skips what depends on it, and the rest still runs', async () => {
    const ran: string[] = []
    const res = await runSwarm({
      tasks: plan([t('a', { id: 'a' }), t('b', { id: 'b', dependsOn: ['a'] }), t('c', { id: 'c' })]),
      limits: limits(),
      run: async (task) => (ran.push(task.id), task.id === 'a' ? ok('boom', { failed: true }) : ok()),
    })
    expect(ran.sort()).toEqual(['a', 'c'])
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'skipped', 'done'])
    expect(res.merged).toMatch(/skipped/)
  })

  it('a thrown error fails that task only', async () => {
    const res = await runSwarm({
      tasks: plan([t('a'), t('b')]),
      limits: limits(),
      run: async (task) => {
        if (task.title === 'a') throw new Error('crash')
        return ok()
      },
    })
    expect(res.results.map((r) => r.status)).toEqual(['failed', 'done'])
  })

  it('stops starting tasks once the model-call cap is spent', async () => {
    const ran: string[] = []
    const res = await runSwarm({
      tasks: plan([t('a'), t('b'), t('c')]),
      limits: limits({ maxParallel: 1, maxModelCalls: 3 }),
      run: async (task) => (ran.push(task.id), ok('x', { modelCalls: 2 })),
    })
    expect(ran).toEqual(['t1', 't2']) // 2 + 2 >= 3, so the third never starts
    expect(res.results[2]).toMatchObject({ status: 'skipped' })
    expect(res.merged).toMatch(/budget/i)
  })

  it('stops starting tasks once the known cost reaches the cap, but unknown cost is never counted as zero', async () => {
    const ran: string[] = []
    await runSwarm({ tasks: plan([t('a'), t('b')]), limits: limits({ maxParallel: 1, maxCostUsd: 0.05 }), run: async (task) => (ran.push(task.id), ok('x', { costUsd: 0.06 })) })
    expect(ran).toEqual(['t1'])

    const ran2: string[] = []
    const res = await runSwarm({ tasks: plan([t('a'), t('b')]), limits: limits({ maxParallel: 1, maxCostUsd: 0.05 }), run: async (task) => (ran2.push(task.id), ok('x', { costUsd: null })) })
    expect(ran2).toEqual(['t1', 't2']) // cost unknown: only the call cap protects
    expect(res.costUsd).toBeNull()
    expect(res.merged).toMatch(/cost unknown/i)
  })

  it('reports status changes as they happen', async () => {
    const seen: string[] = []
    await runSwarm({ tasks: plan([t('a')]), limits: limits(), onStatus: (task, status) => seen.push(`${task.id}:${status}`), run: async () => ok() })
    expect(seen).toEqual(['t1:waiting', 't1:running', 't1:done'])
  })
})
