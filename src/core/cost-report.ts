import type { VaraConfig } from '../config/config.js'
import type { Session } from './types.js'
import { BASELINE_METHOD, sharedMeter, type LimitStatus, type SavingsReport, type UsageMeter } from './usage-meter.js'
import { TIERS, type Tier } from './router.js'

/**
 * Text and commands for the cost layer, shared by the terminal (`/limit`,
 * `/savings`, `/route`), the web slash commands and the CLI. Pure functions:
 * the caller persists the returned config.
 */

const tok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n)))
const usd = (n: number | null) => (n === null ? 'unknown' : `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`)
const pct = (n: number | null) => (n === null ? 'unknown' : `${Math.abs(n) < 10 ? n.toFixed(1) : Math.round(n)}%`)

export function bar(percent: number | null, width = 20): string {
  if (percent === null) return '·'.repeat(width)
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function statusText(st: LimitStatus): string {
  if (!st.configured) return `${st.message}\n  /limit 5000000 tokens per 5h   ·   /limit $20 per month   ·   /limit percent 37`
  const unit = st.unit === 'usd' ? 'dollars' : st.unit === 'percent' ? 'plan percentage' : 'tokens'
  const lines = [`limit (${unit}, ${windowLabel(st)})  ${bar(st.percent)}  ${st.percent === null ? 'unknown' : `${Math.round(st.percent)}%`}`, `  ${st.message}`]
  if (st.resetsAt) lines.push(`  window resets ${new Date(st.resetsAt).toLocaleString()}`)
  return lines.join('\n')
}

function windowLabel(st: LimitStatus): string {
  return st.resetsAt ? 'calendar window' : 'rolling window'
}

export function savingsText(r: SavingsReport, title: string): string {
  if (r.calls === 0) return `${title}: no model calls recorded yet.`
  const lines = [
    `${title}: ${r.calls} model calls (${r.comparedCalls} with a baseline${r.unknownCalls ? `, ${r.unknownCalls} with unreported usage — left out, not counted as zero` : ''})`,
    `  limit units  actual ${tok(r.actualTokens)}  vs plain-loop baseline ${tok(r.baselineTokens)}  →  ${r.tokensSavedPercent === null ? 'unknown' : `${pct(r.tokensSavedPercent)} ${r.tokensSavedPercent >= 0 ? 'saved' : 'MORE than the baseline'}`}`,
    `  dollars      actual ${usd(r.actualUsd)}  vs baseline ${usd(r.baselineUsd)}  →  ${r.usdSavedPercent === null ? 'unknown (not enough priced calls)' : `${pct(r.usdSavedPercent)} saved`}${r.usdCoveredCalls && r.usdCoveredCalls < r.calls ? `  (over ${r.usdCoveredCalls}/${r.calls} priced calls)` : ''}`,
    `  tiers used   strong ${r.byTier.strong} · standard ${r.byTier.standard} · cheap ${r.byTier.cheap}${r.byTier.unrouted ? ` · unrouted ${r.byTier.unrouted}` : ''}`,
  ]
  return lines.join('\n')
}

export function methodText(): string {
  return `How the baseline is estimated: ${BASELINE_METHOD}`
}

/** What the cost engine did in one session, from its own counters. */
export function sessionEngineLines(s: Session): string[] {
  const sv = s.savings
  const r = s.routing
  const lines: string[] = []
  if (r) {
    lines.push(`  router        strong ${r.calls.strong} · standard ${r.calls.standard} · cheap ${r.calls.cheap}${r.escalations ? ` · ${r.escalations} escalation(s) after a failure` : ''}`)
    if (r.last) lines.push(`  last choice   ${r.last.reason}`)
  }
  if (sv) {
    if (sv.compressedChars) lines.push(`  long output   ${tok(Math.round(sv.compressedChars / 4))} tokens of command output kept out (full text retrievable with tool_output)`)
    if (sv.dedupedOutputs) lines.push(`  repeats       ${sv.dedupedOutputs} identical tool results replaced by a pointer`)
    if (sv.summarizedTokens) lines.push(`  summaries     ~${tok(sv.summarizedTokens)} tokens of old turns folded out of every later request`)
    if (sv.skippedVerifications) lines.push(`  verification  ${sv.skippedVerifications} re-run(s) skipped: nothing had changed`)
    if (sv.loopStops) lines.push(`  loop guard    stopped a repeating loop ${sv.loopStops} time(s)`)
  }
  return lines
}

/* ---------------- /limit ---------------- */

export interface CommandOutcome {
  config?: VaraConfig
  text: string
  error?: boolean
}

const WINDOWS: Record<string, { kind: 'rolling' | 'day' | 'week' | 'month'; hours: number }> = {
  day: { kind: 'day', hours: 24 },
  daily: { kind: 'day', hours: 24 },
  week: { kind: 'week', hours: 168 },
  weekly: { kind: 'week', hours: 168 },
  month: { kind: 'month', hours: 720 },
  monthly: { kind: 'month', hours: 720 },
}

function parseAmount(s: string): number | null {
  const m = /^\$?(\d+(?:[.,]\d+)?)\s*([kKmM]?)$/.exec(s.trim())
  if (!m) return null
  const n = Number(m[1]!.replace(',', '.'))
  return m[2]!.toLowerCase() === 'k' ? n * 1_000 : m[2]!.toLowerCase() === 'm' ? n * 1_000_000 : n
}

export function limitCommand(config: VaraConfig, args: string[], now = new Date()): CommandOutcome {
  const bad = (text: string): CommandOutcome => ({ text, error: true })
  const l = config.limits
  const set = (patch: Partial<VaraConfig['limits']>): VaraConfig => ({ ...config, limits: { ...l, ...patch } })
  const [a, b, c, d] = args.map((x) => x.toLowerCase())
  if (!a) return { text: '' }
  if (a === 'off' || a === 'none') return { config: set({ unit: 'none', amount: 0, readings: [] }), text: 'No limit is set now.' }
  if (a === 'eco') {
    if (b === 'on' || b === 'off') {
      const at = c === 'at' && d ? Number(d) : l.ecoAt
      if (!(at >= 1 && at <= 100)) return bad('Usage: /limit eco on [at 85]')
      return {
        config: set({ autoEco: b === 'on', ecoAt: at }),
        text: b === 'on' ? `Auto-eco is ON from ${at}% of your limit: routine turns use a lighter tier, never below your quality floor (${config.routing.floor}).` : 'Auto-eco is off.',
      }
    }
    return bad('Usage: /limit eco on [at 85]   or   /limit eco off')
  }
  if (a === 'percent' || a === '%') {
    const n = Number(b)
    if (!(n >= 0 && n <= 100)) return bad('Usage: /limit percent 37   (the percentage your provider shows right now)')
    const readings = [...l.readings, { at: now.toISOString(), percent: n }].slice(-200)
    return {
      config: set({ unit: 'percent', readings }),
      text: readings.length < 2 ? `Recorded ${n}%. Type another reading later (after some work) and VARA will learn how many tokens are 1% of your plan.` : `Recorded ${n}% (${readings.length} readings).`,
    }
  }
  // /limit 5000000 tokens per 5h   |   /limit $20 per month   |   /limit 20 usd
  const amount = parseAmount(a)
  if (amount === null || amount <= 0) return bad('Usage: /limit 5000000 tokens per 5h  ·  /limit $20 per month  ·  /limit percent 37  ·  /limit eco on  ·  /limit off')
  const dollars = a.startsWith('$') || b === 'usd' || b === 'dollars'
  const per = args.map((x) => x.toLowerCase())
  const perIdx = per.indexOf('per')
  let window = l.window
  if (perIdx >= 0 && per[perIdx + 1]) {
    const w = per[perIdx + 1]!
    const hours = /^(\d+(?:\.\d+)?)h(?:ours?)?$/.exec(w)
    if (hours) window = { kind: 'rolling', hours: Number(hours[1]) }
    else if (WINDOWS[w]) window = WINDOWS[w]!
    else return bad('The window is "5h" (rolling hours), day, week or month.')
  }
  return {
    config: set({ unit: dollars ? 'usd' : 'tokens', amount, window }),
    text: `Limit set: ${dollars ? `$${amount}` : `${tok(amount)} tokens`} ${window.kind === 'rolling' ? `in any ${window.hours} hours` : `per ${window.kind}`}. VARA counts every call against it and warns at ${l.warnAt.join(' / ')}%.`,
  }
}

/* ---------------- /route ---------------- */

export function routeText(config: VaraConfig, s?: Session): string {
  const r = config.routing
  const show = (t: Tier) => {
    const v = r.tiers[t]
    const target = typeof v === 'string' ? v : v ? `${v.model}${v.provider ? ` @${v.provider}` : ''}` : t === 'cheap' ? config.agent.cheapModel || '(none: session model)' : '(session model)'
    return `${t.padEnd(8)} ${target}`
  }
  const lines = [
    `router ${r.enabled ? 'on' : 'off'} · quality floor ${r.floor} (work turns never go below it) · escalate on failure ${r.escalateOnFailure ? 'on' : 'off'}`,
    ...TIERS.slice()
      .reverse()
      .map((t) => `  ${show(t)}`),
    '  change:  /route floor <cheap|standard|strong>  ·  /route <strong|standard|cheap> <model> [provider]  ·  /route <tier> off  ·  /route on|off',
  ]
  const last = s?.routing?.last
  if (last) lines.push(`  last turn: ${last.reason}`)
  return lines.join('\n')
}

export function routeCommand(config: VaraConfig, args: string[]): CommandOutcome {
  const bad = (text: string): CommandOutcome => ({ text, error: true })
  const [a, b, c] = args
  if (!a) return { text: '' }
  const r = config.routing
  if (a === 'on' || a === 'off') return { config: { ...config, routing: { ...r, enabled: a === 'on' } }, text: `Router ${a}.` }
  if (a === 'floor') {
    if (b !== 'cheap' && b !== 'standard' && b !== 'strong') return bad('Usage: /route floor cheap|standard|strong')
    return { config: { ...config, routing: { ...r, floor: b } }, text: `Quality floor: ${b}. Work turns never use a lower tier.${b === 'cheap' ? ' (Note: lowering it to cheap measured no saving on long conversations — see docs/COST.md.)' : ''}` }
  }
  if (a === 'strong' || a === 'standard' || a === 'cheap') {
    const tiers = { ...r.tiers }
    if (!b || b === 'off') {
      delete tiers[a]
      return { config: { ...config, routing: { ...r, tiers } }, text: `${a} tier: back to the default.` }
    }
    tiers[a] = c ? { model: b, provider: c } : b
    return { config: { ...config, routing: { ...r, tiers } }, text: `${a} tier → ${b}${c ? ` on provider ${c}` : ''}.${c && !config.providers[c] ? ` (Warning: no provider named "${c}" is configured; the session model will be used.)` : ''}` }
  }
  return bad('Usage: /route [floor <tier> | <tier> <model> [provider] | <tier> off | on | off]')
}

/** One owner-facing overview: the limit and the savings, both sources. */
export function overviewText(config: VaraConfig, meter: UsageMeter, session?: Session): string {
  const parts = [statusText(meter.status(config.limits))]
  if (session) {
    const own = meter.report({ sid: session.id }, config.limits.cachedWeight)
    parts.push(savingsText(own, 'this session'))
    const engine = sessionEngineLines(session)
    if (engine.length) parts.push(engine.join('\n'))
  }
  parts.push(savingsText(meter.report({ since: Date.now() - 7 * 86_400_000 }, config.limits.cachedWeight), 'last 7 days'))
  parts.push(savingsText(meter.report(undefined, config.limits.cachedWeight), 'all time'))
  return parts.join('\n\n')
}

/** The `/limit`, `/savings` and `/route` commands for any front end. */
export function costCommand(cmd: string, args: string[], config: VaraConfig, session?: Session, meter: UsageMeter = sharedMeter()): CommandOutcome {
  if (cmd === 'savings') return { text: `${overviewText(config, meter, session)}\n\n${methodText()}` }
  if (cmd === 'limit') {
    const out = limitCommand(config, args)
    if (!out.text && !out.config) return { text: statusText(meter.status(config.limits)) }
    const cfg = out.config ?? config
    return { ...(out.config ? { config: out.config } : {}), text: out.error ? out.text : `${out.text}\n${statusText(meter.status(cfg.limits))}`, ...(out.error ? { error: true } : {}) }
  }
  const out = routeCommand(config, args)
  if (!out.text && !out.config) return { text: routeText(config, session) }
  return { ...(out.config ? { config: out.config } : {}), text: out.error ? out.text : `${out.text}\n${routeText(out.config ?? config, session)}`, ...(out.error ? { error: true } : {}) }
}
