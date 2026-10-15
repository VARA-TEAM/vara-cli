import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIMITS,
  UsageMeter,
  calibratePercent,
  computeStatus,
  savingsReport,
  weightedTokens,
  windowStart,
  type LimitsConfig,
  type UsageRecord,
} from '../src/core/usage-meter.js'

const NOW = Date.parse('2026-10-15T12:00:00Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const rec = (msAgo: number, over: Partial<UsageRecord> = {}): UsageRecord => ({
  at: iso(msAgo),
  sid: 's1',
  model: 'm',
  in: 1000,
  cr: 0,
  cw: 0,
  out: 100,
  usd: null,
  baseIn: 1000,
  baseUsd: null,
  ...over,
})
const tokenLimit = (amount: number, over: Partial<LimitsConfig> = {}): LimitsConfig => ({ ...DEFAULT_LIMITS, unit: 'tokens', amount, ...over })

describe('usage meter - limit status', () => {
  it('no limit set: says so and counts nothing', () => {
    const st = computeStatus([rec(1000)], DEFAULT_LIMITS, NOW)
    expect(st.configured).toBe(false)
    expect(st.percent).toBeNull()
    expect(st.message).toContain('No limit set')
  })

  it('counts weighted tokens inside a rolling window and ignores older calls', () => {
    const rs = [rec(60_000, { in: 40_000, out: 10_000 }), rec(6 * 3_600_000, { in: 999_999 })]
    const st = computeStatus(rs, tokenLimit(100_000), NOW)
    expect(st.used).toBe(50_000)
    expect(st.percent).toBe(50)
    expect(st.level).toBe('ok')
  })

  it('cached tokens count at their (lower) weight', () => {
    expect(weightedTokens({ in: 100, cr: 1000, cw: 0, out: 10 }, 0.1)).toBe(210)
    expect(weightedTokens({ in: 100, cr: 1000, cw: 0, out: 10 }, 1)).toBe(1110)
  })

  it('unknown is never zero: unreported calls are counted and the message says the figure may be higher', () => {
    const rs = [rec(1000, { in: 10_000, out: 0 }), rec(2000, { in: null, cr: null, cw: null, out: null })]
    const st = computeStatus(rs, tokenLimit(100_000), NOW)
    expect(st.unknownCalls).toBe(1)
    expect(st.used).toBe(10_000)
    expect(st.message).toContain('did not report usage')
  })

  it('a dollar limit uses known dollars only', () => {
    const rs = [rec(1000, { usd: 1.5 }), rec(2000, { usd: null })]
    const st = computeStatus(rs, { ...DEFAULT_LIMITS, unit: 'usd', amount: 10 }, NOW)
    expect(st.used).toBe(1.5)
    expect(st.percent).toBe(15)
    expect(st.unknownCalls).toBe(1)
  })

  it('warning levels follow the thresholds', () => {
    const at = (tokens: number) => computeStatus([rec(1000, { in: tokens, out: 0 })], tokenLimit(100), NOW).level
    expect(at(50)).toBe('ok')
    expect(at(72)).toBe('warn')
    expect(at(86)).toBe('high')
    expect(at(96)).toBe('critical')
  })

  it('projects a pace from recent activity: "at this rate your limit lasts N hours"', () => {
    // 10 minutes of work used 20k tokens (3 calls) -> 120k/h. 60k of 100k left -> 0.5 h.
    const rs = [rec(10 * 60_000, { in: 10_000, out: 0 }), rec(5 * 60_000, { in: 5_000, out: 0 }), rec(1 * 60_000, { in: 5_000, out: 0 }), rec(3 * 3_600_000, { in: 40_000, out: 0 })]
    const st = computeStatus(rs, tokenLimit(100_000), NOW)
    expect(st.percent).toBe(60)
    expect(st.ratePerHour).toBeGreaterThan(50_000)
    expect(st.hoursLeft).not.toBeNull()
    expect(st.hoursLeft!).toBeLessThan(1)
    expect(st.message).toContain('At this pace it lasts')
  })

  it('gives no pace when there is not enough recent activity (and says so, no invented number)', () => {
    const st = computeStatus([rec(3 * 3_600_000, { in: 40_000, out: 0 })], tokenLimit(100_000), NOW)
    expect(st.ratePerHour).toBeNull()
    expect(st.hoursLeft).toBeNull()
    expect(st.message).toContain('Not enough recent activity')
  })

  it('a calendar window resets at its boundary', () => {
    const start = windowStart({ kind: 'day', hours: 0 }, NOW)
    expect(new Date(start).getHours()).toBe(0)
    const st = computeStatus([rec(1000)], { ...tokenLimit(1000), window: { kind: 'day', hours: 0 } }, NOW)
    expect(st.resetsAt).not.toBeNull()
  })
})

describe('usage meter - a plan percentage the user types', () => {
  const limits = (readings: Array<{ at: string; percent: number }>): LimitsConfig => ({ ...DEFAULT_LIMITS, unit: 'percent', readings })

  it('needs two readings before it claims to know the size of 1%', () => {
    const one = computeStatus([rec(1000)], limits([{ at: iso(3_600_000), percent: 10 }]), NOW)
    expect(one.calibration.tokensPerPercent).toBeNull()
    expect(one.percent).toBe(10) // the reading as typed, nothing invented
    expect(one.message).toContain('One reading')
    expect(computeStatus([], limits([]), NOW).message).toContain('Type your plan percentage')
  })

  it('learns tokens-per-percent from two readings and projects from the latest', () => {
    // 60k weighted tokens between the readings while the plan went 10% -> 40%: 2000 tokens per 1%.
    const rs = [rec(100 * 60_000, { in: 30_000, out: 0 }), rec(80 * 60_000, { in: 30_000, out: 0 }), rec(10 * 60_000, { in: 4_000, out: 0 }), rec(2 * 60_000, { in: 2_000, out: 0 })]
    const readings = [
      { at: iso(120 * 60_000), percent: 10 },
      { at: iso(60 * 60_000), percent: 40 },
    ]
    expect(calibratePercent(rs, limits(readings)).tokensPerPercent).toBeCloseTo(2000, 0)
    const st = computeStatus(rs, limits(readings), NOW)
    expect(st.limit).toBeCloseTo(200_000, -2)
    expect(st.percent).toBeCloseTo(43, 0) // 40% + 6000/2000
  })

  it('ignores a pair where the percentage fell (the provider window reset)', () => {
    const rs = [rec(30 * 60_000, { in: 10_000, out: 0 })]
    const cal = calibratePercent(rs, limits([{ at: iso(120 * 60_000), percent: 90 }, { at: iso(60 * 60_000), percent: 5 }]))
    expect(cal.tokensPerPercent).toBeNull()
  })
})

describe('savings report', () => {
  it('compares actual to the baseline, counts unknowns separately and never invents dollars', () => {
    const rs = [
      rec(1, { in: 1000, cr: 9000, out: 100, baseIn: 12_000, usd: 0.002, baseUsd: 0.04, tier: 'standard' }),
      rec(2, { in: 500, cr: 0, out: 50, baseIn: 600, usd: null, baseUsd: null, tier: 'cheap' }),
      rec(3, { in: null, cr: null, cw: null, out: null, baseIn: 700, tier: 'strong' }),
    ]
    const r = savingsReport(rs, 0.1)
    expect(r.calls).toBe(3)
    expect(r.comparedCalls).toBe(2)
    expect(r.unknownCalls).toBe(1)
    expect(r.actualTokens).toBe(1000 + 900 + 100 + 500 + 50)
    expect(r.baselineTokens).toBe(12_100 + 650)
    expect(r.tokensSavedPercent).toBeCloseTo(80, 0)
    expect(r.usdCoveredCalls).toBe(1)
    expect(r.usdSavedPercent).toBeCloseTo(95, 0)
    expect(r.byTier).toEqual({ strong: 1, standard: 1, cheap: 1, unrouted: 0 })
    expect(r.method).toContain('plain agent loop')
  })

  it('an empty ledger yields null percentages, not zero', () => {
    const r = savingsReport([])
    expect(r.tokensSavedPercent).toBeNull()
    expect(r.usdSavedPercent).toBeNull()
    expect(r.actualUsd).toBeNull()
  })

  it('an overhead call (a summary) adds cost but no baseline', () => {
    const r = savingsReport([rec(1, { in: 5000, out: 300, baseIn: 0, ovh: true }), rec(2, { in: 1000, out: 100, baseIn: 1000 })], 1)
    expect(r.actualTokens).toBe(5300 + 1100)
    expect(r.baselineTokens).toBe(1100)
    expect(r.tokensSavedPercent!).toBeLessThan(0) // honest: the summary has not paid off yet
  })
})

describe('usage meter - ledger file', () => {
  it('persists records and reloads them, tolerating a torn last line', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-meter-'))
    try {
      const file = join(dir, 'usage.jsonl')
      const a = new UsageMeter(file)
      a.add(rec(1000))
      a.add(rec(2000, { sid: 's2' }))
      await a.flush()
      const text = await readFile(file, 'utf8')
      expect(text.trim().split('\n')).toHaveLength(2)
      await import('node:fs/promises').then((fs) => fs.appendFile(file, '{"at": "torn'))
      const b = new UsageMeter(file)
      await b.load()
      expect(b.all()).toHaveLength(2)
      expect(b.report({ sid: 's2' }).calls).toBe(1)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
