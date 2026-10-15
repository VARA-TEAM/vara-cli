import type { VaraConfig } from '../config/config.js'
import type { LimitStatus, SavingsReport, UsageMeter } from '../core/usage-meter.js'

/**
 * The owner's cost board: limit status, savings, routing and context settings,
 * and the patch that changes them. Lives apart from manage.ts so the owner API
 * and the web components share one shape (ui/src/components/Cost*.tsx).
 */

export interface CostBoard {
  limits: VaraConfig['limits']
  status: LimitStatus
  savings: { day: SavingsReport; week: SavingsReport; all: SavingsReport }
  routing: { enabled: boolean; floor: string; escalateOnFailure: boolean; tiers: Record<string, { model: string; provider?: string } | null>; cheapModelLegacy: string }
  context: { summarize: boolean; toolOutputChars: number; smartRead: boolean }
}

function target(v: unknown): { model: string; provider?: string } | null {
  if (typeof v === 'string' && v) return { model: v }
  if (v && typeof v === 'object' && typeof (v as { model?: unknown }).model === 'string') {
    const o = v as { model: string; provider?: string }
    return { model: o.model, ...(o.provider ? { provider: o.provider } : {}) }
  }
  return null
}

export function costBoard(config: VaraConfig, meter: UsageMeter, now = Date.now()): CostBoard {
  const w = config.limits.cachedWeight
  return {
    limits: config.limits,
    status: meter.status(config.limits, now),
    savings: {
      day: meter.report({ since: now - 86_400_000 }, w),
      week: meter.report({ since: now - 7 * 86_400_000 }, w),
      all: meter.report(undefined, w),
    },
    routing: {
      enabled: config.routing.enabled,
      floor: config.routing.floor,
      escalateOnFailure: config.routing.escalateOnFailure,
      tiers: { strong: target(config.routing.tiers.strong), standard: target(config.routing.tiers.standard), cheap: target(config.routing.tiers.cheap) },
      cheapModelLegacy: config.agent.cheapModel,
    },
    context: { summarize: config.context.summarize, toolOutputChars: config.context.toolOutputChars, smartRead: config.context.smartRead },
  }
}

const num = (v: unknown, min: number, max: number, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) throw new Error(`${what}: a number from ${min} to ${max}.`)
  return v
}

/** Apply a settings patch. Throws an Error with a plain message on bad input. */
export function applyCostPatch(config: VaraConfig, body: Record<string, unknown>, now = new Date()): VaraConfig {
  let n = config
  const l = body['limits'] as Record<string, unknown> | undefined
  if (l) {
    const next = { ...n.limits, window: { ...n.limits.window } }
    if ('unit' in l) {
      if (l['unit'] !== 'none' && l['unit'] !== 'tokens' && l['unit'] !== 'usd' && l['unit'] !== 'percent') throw new Error('Limit unit: none, tokens, usd or percent.')
      next.unit = l['unit']
    }
    if ('amount' in l) next.amount = num(l['amount'], 0, 1e12, 'Limit amount')
    const win = l['window'] as Record<string, unknown> | undefined
    if (win) {
      if ('kind' in win) {
        if (win['kind'] !== 'rolling' && win['kind'] !== 'day' && win['kind'] !== 'week' && win['kind'] !== 'month') throw new Error('Window: rolling, day, week or month.')
        next.window.kind = win['kind']
      }
      if ('hours' in win) next.window.hours = num(win['hours'], 0.25, 24 * 31, 'Window hours')
    }
    if (typeof l['autoEco'] === 'boolean') next.autoEco = l['autoEco']
    if ('ecoAt' in l) next.ecoAt = num(l['ecoAt'], 1, 100, 'Eco threshold')
    if ('cachedWeight' in l) next.cachedWeight = num(l['cachedWeight'], 0, 1, 'Cached weight')
    if (Array.isArray(l['warnAt'])) {
      const w = (l['warnAt'] as unknown[]).map((x) => num(x, 1, 100, 'Warning level'))
      if (w.length !== 3 || !(w[0]! < w[1]! && w[1]! < w[2]!)) throw new Error('Warning levels: three increasing percentages.')
      next.warnAt = w
    }
    if ('addReading' in l) {
      const r = l['addReading'] as { percent?: unknown } | number
      const percent = typeof r === 'number' ? r : r?.percent
      next.readings = [...next.readings, { at: now.toISOString(), percent: num(percent, 0, 100, 'Plan percentage') }].slice(-200)
      next.unit = 'percent'
    }
    if (l['clearReadings'] === true) next.readings = []
    n = { ...n, limits: next }
  }
  const r = body['routing'] as Record<string, unknown> | undefined
  if (r) {
    const next = { ...n.routing, tiers: { ...n.routing.tiers } }
    if (typeof r['enabled'] === 'boolean') next.enabled = r['enabled']
    if (typeof r['escalateOnFailure'] === 'boolean') next.escalateOnFailure = r['escalateOnFailure']
    if ('floor' in r) {
      if (r['floor'] !== 'cheap' && r['floor'] !== 'standard' && r['floor'] !== 'strong') throw new Error('Quality floor: cheap, standard or strong.')
      next.floor = r['floor']
    }
    const tiers = r['tiers'] as Record<string, unknown> | undefined
    if (tiers) {
      for (const k of ['strong', 'standard', 'cheap'] as const) {
        if (!(k in tiers)) continue
        const t = tiers[k]
        if (t === null || t === '') delete next.tiers[k]
        else {
          const tt = target(t)
          if (!tt || tt.model.length > 200) throw new Error(`The ${k} tier: a model id, optionally with a provider name.`)
          next.tiers[k] = tt.provider ? { model: tt.model, provider: tt.provider } : tt.model
        }
      }
    }
    n = { ...n, routing: next }
  }
  const c = body['context'] as Record<string, unknown> | undefined
  if (c) {
    const next = { ...n.context }
    if (typeof c['summarize'] === 'boolean') next.summarize = c['summarize']
    if (typeof c['smartRead'] === 'boolean') next.smartRead = c['smartRead']
    if ('toolOutputChars' in c) next.toolOutputChars = Math.round(num(c['toolOutputChars'], 1000, 12000, 'Command output kept (characters)'))
    n = { ...n, context: next }
  }
  return n
}
