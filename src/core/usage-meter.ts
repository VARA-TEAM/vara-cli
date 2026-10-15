import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { VARA_HOME } from '../config/paths.js'
import { findModel } from '../llm/registry.js'
import type { ModelCallRecord, Session } from './types.js'

/**
 * Usage meter: how much of the user's limit is spent, how fast, and what the
 * cost engine saved.
 *
 * Rules that never bend:
 *   - UNKNOWN IS NOT ZERO. A call whose tokens the provider did not report is
 *     counted in `unknownCalls`; it never adds 0 to a total and never makes a
 *     percentage look smaller than it can be shown to be.
 *   - The limit is whatever the user typed (tokens, dollars, or a plan
 *     percentage they read from their provider). VARA never claims to know a
 *     provider's private quota.
 *   - The savings baseline is an ESTIMATE with a stated method (see
 *     `BASELINE_METHOD`); the report prints it.
 */

export type LimitUnit = 'none' | 'tokens' | 'usd' | 'percent'
export type WindowKind = 'rolling' | 'day' | 'week' | 'month'

export interface LimitsConfig {
  unit: LimitUnit
  /** Tokens or dollars. Ignored for `percent` (the limit is calibrated from readings). */
  amount: number
  window: { kind: WindowKind; hours: number }
  /** Percentages at which a soft warning is shown. */
  warnAt: number[]
  /** Opt-in: tighten routing near the limit. */
  autoEco: boolean
  ecoAt: number
  /** How much a cached input token counts against a token limit (providers bill them far lower). */
  cachedWeight: number
  /** The plan percentages the user typed: "I am at 37% now". */
  readings: Array<{ at: string; percent: number }>
}

export const DEFAULT_LIMITS: LimitsConfig = {
  unit: 'none',
  amount: 0,
  window: { kind: 'rolling', hours: 5 },
  warnAt: [70, 85, 95],
  autoEco: false,
  ecoAt: 85,
  cachedWeight: 0.1,
  readings: [],
}

/** One model call in the long-lived ledger (`~/.vara/usage.jsonl`). */
export interface UsageRecord {
  at: string
  sid: string
  model: string
  tier?: 'strong' | 'standard' | 'cheap'
  phase?: string
  /** Billed input, cache read, cache write, output — null when the provider did not say. */
  in: number | null
  cr: number | null
  cw: number | null
  out: number | null
  usd: number | null
  /** Estimated input tokens of the same request in a plain loop. */
  baseIn: number | null
  /** What the plain loop would have cost on the session's own (strong) model, or null if its price is unknown. */
  baseUsd: number | null
  /** A call that exists only because of the cost engine (a summary): it adds cost but has no baseline. */
  ovh?: boolean
}

export const BASELINE_METHOD =
  `Baseline = the same conversation sent as a plain agent loop would send it: every message at its original length (no compaction, summary, dedupe or compression; tool output capped at 12 000 characters like v0.4.0), no prompt cache, one model (the one you chose for the session) and the same output tokens. The baseline input size is estimated at 4 characters per token; the actual side always uses the provider's own reported counts. It does not count turns that smarter prompting or loop-stopping avoided, so it is conservative in that direction, and it cannot know how a different model would have behaved.`

export const ledgerFile = join(VARA_HOME, 'usage.jsonl')

/* ---------------- pure functions ---------------- */

export function windowStart(w: LimitsConfig['window'], now: number): number {
  const d = new Date(now)
  if (w.kind === 'rolling') return now - Math.max(0.25, w.hours) * 3_600_000
  if (w.kind === 'day') return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  if (w.kind === 'week') {
    const day = (d.getDay() + 6) % 7 // Monday = 0
    return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day).getTime()
  }
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

/** When the window resets (null for a rolling window: it slides). */
export function windowEnd(w: LimitsConfig['window'], now: number): number | null {
  const d = new Date(now)
  if (w.kind === 'rolling') return null
  const s = windowStart(w, now)
  const sd = new Date(s)
  if (w.kind === 'day') return new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 1).getTime()
  if (w.kind === 'week') return new Date(sd.getFullYear(), sd.getMonth(), sd.getDate() + 7).getTime()
  return new Date(d.getFullYear(), d.getMonth() + 1, 1).getTime()
}

/** Weighted tokens of one record, or null when the provider reported nothing at all. */
export function weightedTokens(r: Pick<UsageRecord, 'in' | 'cr' | 'cw' | 'out'>, cachedWeight: number): number | null {
  if (r.in === null && r.cr === null && r.cw === null && r.out === null) return null
  return (r.in ?? 0) + (r.cw ?? 0) + (r.cr ?? 0) * cachedWeight + (r.out ?? 0)
}

export interface LimitStatus {
  configured: boolean
  unit: LimitUnit
  /** Units spent in the window (tokens or USD); known calls only. */
  used: number
  /** The limit in the same unit, or null when it cannot be known yet (percent without two readings). */
  limit: number | null
  percent: number | null
  /** Calls in the window whose usage/cost was not reported — the percentage is a floor, not exact. */
  unknownCalls: number
  level: 'ok' | 'warn' | 'high' | 'critical' | 'unknown'
  windowStart: string
  resetsAt: string | null
  /** Units per hour over the recent past; null when there is not enough recent activity to say. */
  ratePerHour: number | null
  hoursLeft: number | null
  /** The pace says the limit lasts past the reset: no need to worry. */
  lastsUntilReset: boolean
  /** For percent limits: tokens that equal 1% (calibrated), and how many readings were used. */
  calibration: { tokensPerPercent: number | null; readings: number }
  /** Human sentence, never claims what it does not know. */
  message: string
}

function inWindow(rs: readonly UsageRecord[], from: number, to: number): UsageRecord[] {
  return rs.filter((r) => {
    const t = Date.parse(r.at)
    return t >= from && t <= to
  })
}

function unitsOf(r: UsageRecord, cfg: LimitsConfig, tokensBased: boolean): number | null {
  return tokensBased ? weightedTokens(r, cfg.cachedWeight) : r.usd
}

/** Tokens per 1% from the user's readings: needs two readings, and usage between them. */
export function calibratePercent(rs: readonly UsageRecord[], cfg: LimitsConfig): { tokensPerPercent: number | null; readings: number } {
  const readings = [...cfg.readings].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
  if (readings.length < 2) return { tokensPerPercent: null, readings: readings.length }
  // Use the latest pair that moved forward (percent can reset when the provider's window resets).
  for (let i = readings.length - 1; i > 0; i--) {
    const b = readings[i]!
    const a = readings[i - 1]!
    const dp = b.percent - a.percent
    if (dp <= 0) continue
    let tokens = 0
    for (const r of inWindow(rs, Date.parse(a.at), Date.parse(b.at))) tokens += weightedTokens(r, cfg.cachedWeight) ?? 0
    if (tokens > 0) return { tokensPerPercent: tokens / dp, readings: readings.length }
  }
  return { tokensPerPercent: null, readings: readings.length }
}

export function computeStatus(rs: readonly UsageRecord[], cfg: LimitsConfig, now = Date.now(), paceMinutes = 30): LimitStatus {
  const start = windowStart(cfg.window, now)
  const end = windowEnd(cfg.window, now)
  const base: LimitStatus = {
    configured: cfg.unit !== 'none',
    unit: cfg.unit,
    used: 0,
    limit: null,
    percent: null,
    unknownCalls: 0,
    level: 'unknown',
    windowStart: new Date(start).toISOString(),
    resetsAt: end ? new Date(end).toISOString() : null,
    ratePerHour: null,
    hoursLeft: null,
    lastsUntilReset: false,
    calibration: { tokensPerPercent: null, readings: cfg.readings.length },
    message: 'No limit set. Tell VARA your limit with /limit to see how long it lasts.',
  }
  if (cfg.unit === 'none') return base

  const tokensBased = cfg.unit !== 'usd'
  const win = inWindow(rs, start, now)
  let used = 0
  let unknown = 0
  for (const r of win) {
    const u = unitsOf(r, cfg, tokensBased)
    if (u === null) unknown++
    else used += u
  }

  let limit: number | null = null
  let calibration = base.calibration
  if (cfg.unit === 'percent') {
    calibration = calibratePercent(rs, cfg)
    if (calibration.tokensPerPercent) limit = calibration.tokensPerPercent * 100
  } else if (cfg.amount > 0) limit = cfg.amount

  // The user's own latest reading is the truth for a percent limit.
  const lastReading = [...cfg.readings].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0]
  let percent: number | null = null
  if (cfg.unit === 'percent' && lastReading) {
    // reading + usage since the reading, if calibrated; else the reading as typed.
    let since = 0
    for (const r of inWindow(rs, Date.parse(lastReading.at), now)) since += weightedTokens(r, cfg.cachedWeight) ?? 0
    percent = calibration.tokensPerPercent ? lastReading.percent + since / calibration.tokensPerPercent : lastReading.percent
    if (limit === null) limit = null
  } else if (limit) percent = (used / limit) * 100

  // Pace.
  const recent = inWindow(rs, now - paceMinutes * 60_000, now)
  let recentUnits = 0
  for (const r of recent) recentUnits += unitsOf(r, cfg, tokensBased) ?? 0
  const firstRecent = recent.length ? Math.min(...recent.map((r) => Date.parse(r.at))) : now
  const spanH = Math.max((now - Math.max(firstRecent, now - paceMinutes * 60_000)) / 3_600_000, 5 / 60)
  const ratePerHour = recent.length >= 2 && recentUnits > 0 ? recentUnits / Math.max(spanH, 10 / 60) : null

  let hoursLeft: number | null = null
  let lastsUntilReset = false
  if (limit && ratePerHour && percent !== null) {
    const remaining = Math.max(0, limit * (1 - percent / 100))
    hoursLeft = remaining / ratePerHour
    if (end && hoursLeft * 3_600_000 > end - now) lastsUntilReset = true
  }

  const level: LimitStatus['level'] =
    percent === null ? 'unknown' : percent >= (cfg.warnAt[2] ?? 95) ? 'critical' : percent >= (cfg.warnAt[1] ?? 85) ? 'high' : percent >= (cfg.warnAt[0] ?? 70) ? 'warn' : 'ok'

  const fmtUnit = (n: number) => (cfg.unit === 'usd' ? `$${n.toFixed(2)}` : n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
  let message: string
  if (percent === null) {
    message =
      cfg.unit === 'percent'
        ? calibration.readings === 0
          ? 'Type your plan percentage with /limit percent <n> now, and again later: two readings let VARA learn how many tokens are 1%.'
          : 'One reading so far — type another with /limit percent <n> after some work so VARA can learn the size of 1%.'
        : 'The limit is not set.'
  } else {
    const pct = `${percent.toFixed(percent < 10 ? 1 : 0)}%`
    const pace =
      hoursLeft !== null
        ? lastsUntilReset
          ? ' At this pace it lasts until the window resets.'
          : ` At this pace it lasts about ${hoursLeft < 1 ? `${Math.max(1, Math.round(hoursLeft * 60))} minutes` : `${hoursLeft.toFixed(1)} hours`}.`
        : ' Not enough recent activity to project a pace.'
    const learn = cfg.unit === 'percent' && !calibration.tokensPerPercent ? ' One reading so far: type another with /limit percent <n> after some work so VARA can learn what 1% is.' : ''
    message = `${pct} of your limit used${limit ? ` (${fmtUnit(used)} of ${fmtUnit(limit)})` : ''}.${learn}${pace}${unknown ? ` ${unknown} call(s) did not report usage, so the real figure may be higher.` : ''}`
  }

  return { ...base, used, limit, percent, unknownCalls: unknown, level, ratePerHour, hoursLeft, lastsUntilReset, calibration, message }
}

export interface SavingsReport {
  calls: number
  /** Calls that have both an actual and a baseline figure. */
  comparedCalls: number
  unknownCalls: number
  actualTokens: number
  baselineTokens: number
  tokensSavedPercent: number | null
  /** Dollars: only over calls where BOTH figures are known. */
  usdCoveredCalls: number
  actualUsd: number | null
  baselineUsd: number | null
  usdSavedPercent: number | null
  byTier: { strong: number; standard: number; cheap: number; unrouted: number }
  method: string
}

export function savingsReport(rs: readonly UsageRecord[], cachedWeight = 1): SavingsReport {
  // Cached tokens count at their real weight in "limit units", so the saving is not overstated.
  let actualTokens = 0
  let baselineTokens = 0
  let compared = 0
  let unknown = 0
  let usdCovered = 0
  let aUsd = 0
  let bUsd = 0
  const byTier = { strong: 0, standard: 0, cheap: 0, unrouted: 0 }
  for (const r of rs) {
    if (r.tier) byTier[r.tier]++
    else byTier.unrouted++
    const a = weightedTokens(r, cachedWeight)
    if (a === null || r.baseIn === null) {
      unknown++
    } else {
      compared++
      actualTokens += a
      baselineTokens += r.ovh ? 0 : r.baseIn + (r.out ?? 0)
    }
    if (r.usd !== null && r.baseUsd !== null) {
      usdCovered++
      aUsd += r.usd
      bUsd += r.baseUsd
    }
  }
  return {
    calls: rs.length,
    comparedCalls: compared,
    unknownCalls: unknown,
    actualTokens,
    baselineTokens,
    tokensSavedPercent: compared > 0 && baselineTokens > 0 ? ((baselineTokens - actualTokens) / baselineTokens) * 100 : null,
    usdCoveredCalls: usdCovered,
    actualUsd: usdCovered > 0 ? aUsd : null,
    baselineUsd: usdCovered > 0 ? bUsd : null,
    usdSavedPercent: usdCovered > 0 && bUsd > 0 ? ((bUsd - aUsd) / bUsd) * 100 : null,
    byTier,
    method: BASELINE_METHOD,
  }
}

/** USD of a plain, uncached request on `model` — null when its price is unknown. */
export function baselineUsd(model: string, providerId: string | undefined, baseInputTokens: number, outputTokens: number | null): number | null {
  const spec = findModel(model, providerId)
  if (!spec?.pricing || outputTokens === null) return null
  return (baseInputTokens / 1_000_000) * spec.pricing.inputPer1M + (outputTokens / 1_000_000) * spec.pricing.outputPer1M
}

/** Estimate (chars/4) of what a plain loop would send now: every message at its original size. */
export function naiveInputTokens(session: Session, overheadChars: number): number {
  let chars = overheadChars
  for (const m of session.transcript) {
    if (m.role === 'tool' && m.fullLength === undefined) chars += Math.min(m.content.length, 12_000)
    else chars += m.fullLength ?? m.content.length
    for (const c of m.toolCalls ?? []) chars += c.arguments.length + c.name.length + 20
  }
  return Math.ceil(chars / 4)
}

export function recordFromCall(sessionId: string, call: ModelCallRecord, baseModel: string, baseInputTokens: number | null): UsageRecord {
  return {
    at: call.at,
    sid: sessionId,
    model: call.model,
    ...(call.tier ? { tier: call.tier } : {}),
    ...(call.phase ? { phase: call.phase } : {}),
    in: call.inputTokens,
    cr: call.cachedInputTokens,
    cw: call.cacheWriteTokens,
    out: call.outputTokens,
    usd: call.costUsd,
    baseIn: baseInputTokens,
    baseUsd: baseInputTokens === null ? null : baselineUsd(baseModel, call.providerId, baseInputTokens, call.outputTokens),
  }
}

/* ---------------- the stateful meter ---------------- */

export class UsageMeter {
  private records: UsageRecord[] = []
  private loaded = false
  private writeQueue: Promise<void> = Promise.resolve()

  constructor(private readonly file: string = ledgerFile) {}

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.file)) return
    try {
      const text = await readFile(this.file, 'utf8')
      const loaded: UsageRecord[] = []
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        try {
          const r = JSON.parse(line) as UsageRecord
          if (typeof r.at === 'string' && typeof r.sid === 'string') loaded.push(r)
        } catch {
          /* a torn last line must not lose the rest */
        }
      }
      this.records = [...loaded, ...this.records]
    } catch {
      /* an unreadable ledger must never stop the agent */
    }
  }

  add(record: UsageRecord): void {
    this.records.push(record)
    const file = this.file
    this.writeQueue = this.writeQueue
      .then(async () => {
        await mkdir(dirname(file), { recursive: true })
        await appendFile(file, JSON.stringify(record) + '\n', 'utf8')
      })
      .catch(() => {})
  }

  all(): readonly UsageRecord[] {
    return this.records
  }

  status(cfg: LimitsConfig, now = Date.now()): LimitStatus {
    return computeStatus(this.records, cfg, now)
  }

  report(filter?: { sid?: string; since?: number }, cachedWeight = 1): SavingsReport {
    const rs = this.records.filter((r) => (!filter?.sid || r.sid === filter.sid) && (!filter?.since || Date.parse(r.at) >= filter.since))
    return savingsReport(rs, cachedWeight)
  }

  /** Resolves when everything added so far is on disk (tests, shutdown). */
  flush(): Promise<void> {
    return this.writeQueue
  }
}

let shared: UsageMeter | null = null
/** The process-wide meter every front end shares. */
export function sharedMeter(): UsageMeter {
  if (!shared) {
    shared = new UsageMeter()
    void shared.load()
  }
  return shared
}
