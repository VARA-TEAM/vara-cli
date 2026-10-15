import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ARMS, CHEAP as CHEAP_ID, runChatScenario, runLoopScenario, runNavigationScenario, runVerifyScenario, runWorkArm, simulateLookback, countBreakpoints, type ArmResult } from './bench/scenarios.js'

/**
 * The benchmark, as a regression test. The numbers in docs/COST.md come from
 * `npx tsx scripts/cost-bench.ts`; these assertions keep the DIRECTION and the
 * rough size of each claim true, with margins so an unrelated tweak to a
 * prompt does not break the build.
 */
describe('cost bench - offline, scripted, measured', () => {
  const sessions: Record<string, ArmResult[]> = { medium: [], long: [] }

  it('a medium working session: output economics cut limit units, and the router cuts dollars', async () => {
    for (const arm of ARMS) sessions['medium']!.push(await runWorkArm(arm, 22))
    const [a, b, c, d] = sessions['medium'] as [ArmResult, ArmResult, ArmResult, ArmResult]
    for (const r of sessions['medium']!) expect(r.state).toBe('completed')
    expect(b.weightedTokens).toBeLessThan(a.weightedTokens * 0.9)
    expect(c.weightedTokens).toBeLessThanOrEqual(b.weightedTokens * 1.001) // no summary needed yet: never worse
    // The router moves work off the strong model: dollars drop by far more than tokens.
    expect(d.usd!).toBeLessThan(a.usd! * 0.4)
    // The prefix stays cache-stable: most input is served from cache in every arm.
    for (const r of sessions['medium']!) expect(r.cacheShare).toBeGreaterThan(0.8)
    // The engine's own savings report agrees in direction and states its method.
    expect(c.report.tokensSavedPercent!).toBeGreaterThan(0)
    expect(c.report.method).toContain('plain agent loop')
    expect(c.report.calls).toBe(c.requests)
  }, 180_000)

  // The long session takes ~25 s of CPU; it runs on demand (VARA_BENCH_LONG=1) so the default suite stays light.
  it.skipIf(!process.env['VARA_BENCH_LONG'])('a long working session: summaries of old turns add a large further saving', async () => {
    for (const arm of ARMS) sessions['long']!.push(await runWorkArm(arm, 80))
    const [a, b, c, d] = sessions['long'] as [ArmResult, ArmResult, ArmResult, ArmResult]
    for (const r of sessions['long']!) expect(r.state).toBe('completed')
    expect(b.weightedTokens).toBeLessThan(a.weightedTokens * 0.9)
    expect(c.weightedTokens).toBeLessThan(b.weightedTokens * 0.85)
    expect(c.savings.summarizedTokens!).toBeGreaterThan(10_000)
    expect(c.byModel[CHEAP_ID]).toBe(1) // exactly one cheap summary call
    expect(d.usd!).toBeLessThan(a.usd! * 0.3)
    // The summary call is counted as cost in the report, not hidden.
    expect(c.report.calls).toBe(c.requests)
  }, 240_000)

  it('lowering the floor to cheap is a trade, not a free win: dollars drop, limit units do not', () => {
    for (const key of ['medium', 'long']) {
      if (!sessions[key]!.length) continue
      const d = sessions[key]![3]!
      const e = sessions[key]![4]!
      expect(e.weightedTokens).toBeGreaterThanOrEqual(d.weightedTokens * 0.999) // never fewer limit units than the standard floor
      expect(e.cacheShare).toBeLessThanOrEqual(d.cacheShare + 0.001) // switching models does not improve the cache
    }
  })

  it('a runaway loop is cut after 5 calls instead of burning the 60-turn budget', async () => {
    const r = await runLoopScenario()
    expect(r.requestsWithout).toBeGreaterThanOrEqual(55)
    expect(r.requestsWith).toBe(5)
  }, 60_000)

  it('verification is not re-run when nothing changed', async () => {
    const r = await runVerifyScenario()
    expect(r.runsWithout).toBe(3)
    expect(r.runsWith).toBe(1)
  }, 60_000)

  it('chat and questions on the cheap tier cost a fraction', async () => {
    const r = await runChatScenario()
    expect(r.usdAllStrong).not.toBeNull()
    expect(r.usdRouted).not.toBeNull()
    expect(r.usdRouted!).toBeLessThan(r.usdAllStrong! * 0.2)
  }, 60_000)

  it('finding code: repo_map + read_symbol cost far less than reading the files that mention a name', async () => {
    const r = await runNavigationScenario(resolve(import.meta.dirname, '..'))
    expect(r.files).toBeGreaterThan(50)
    expect(r.tokensWithMap).toBeLessThan(r.tokensExploring * 0.5)
    expect(r.longFileTokensOutline).toBeLessThan(r.longFileTokensFull)
  }, 60_000)

  it('the extra cache breakpoint is insurance: no difference for a normal tool turn, a lifeline when one turn adds 20+ positions', () => {
    expect(countBreakpoints()).toBe(2)
    const typical = simulateLookback(3)
    expect(typical.cachedShareNew).toBeCloseTo(typical.cachedShareOld, 5)
    const big = simulateLookback(25)
    expect(big.cachedShareOld).toBeLessThan(0.05)
    expect(big.cachedShareNew).toBeGreaterThan(0.8)
  })
})
