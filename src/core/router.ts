import type { SessionIntent } from './types.js'

/**
 * The model router: one pure function that picks the model for ONE turn.
 *
 *   tier     strong · standard · cheap  (configurable per provider/model)
 *   phase    why this turn exists: plan, edit, search, recover, verify,
 *            chat, answer, summarise, subagent
 *   floor    the lowest tier the user accepts for WORK turns. It is applied
 *            last, so nothing (eco mode, "search is mechanical", a missing
 *            config) can push a work turn below it.
 *
 * Rules, in order:
 *   1. conversation (chat / question) and summaries are cheap by nature;
 *   2. the first turn of work, and any plan-mode turn, is planning: strong for
 *      a clearly complex objective, standard otherwise;
 *   3. a failed verification, or two failures of one tool in a row, ESCALATES:
 *      one tier above what was used, never below standard;
 *   4. a turn that only follows successful read/search results is mechanical
 *      (search) → cheap, if the floor allows;
 *   5. everything else is an edit turn → standard;
 *   6. eco mode (opt-in, near the user's limit) lowers 4–5 by one tier, still
 *      clamped by the floor;
 *   7. downgrades need two consecutive turns that want the lower tier
 *      (hysteresis) and a small conversation (SWITCH_CONTEXT_LIMIT): every
 *      model has its own prompt cache, so moving a long conversation to
 *      another model re-bills all of it uncached (measured: docs/COST.md).
 *
 * With no tiers configured the router reproduces v0.4.0: `cheapModel` for chat,
 * questions and sub-agents, the session model for everything else.
 */

export type Tier = 'cheap' | 'standard' | 'strong'
export const TIERS: readonly Tier[] = ['cheap', 'standard', 'strong']
const RANK: Record<Tier, number> = { cheap: 0, standard: 1, strong: 2 }

export function tierRank(t: Tier): number {
  return RANK[t]
}
export function maxTier(a: Tier, b: Tier): Tier {
  return RANK[a] >= RANK[b] ? a : b
}
export function lowerTier(t: Tier): Tier {
  return t === 'strong' ? 'standard' : 'cheap'
}
export function higherTier(t: Tier): Tier {
  return t === 'cheap' ? 'standard' : 'strong'
}

/** A model, optionally on another configured provider. */
export interface TierTarget {
  model: string
  /** Name of a provider in `config.providers`; absent = the session's provider. */
  provider?: string
}

export interface RouterSettings {
  enabled: boolean
  tiers: { strong?: TierTarget; standard?: TierTarget; cheap?: TierTarget }
  /** Lowest tier accepted for work turns. */
  floor: Tier
  escalateOnFailure: boolean
  /** Eco mode is ON right now (the user opted in AND the limit threshold was crossed). */
  eco: boolean
}

export const DEFAULT_ROUTER: RouterSettings = { enabled: true, tiers: {}, floor: 'standard', escalateOnFailure: true, eco: false }

export type Phase = 'plan' | 'edit' | 'search' | 'recover' | 'verify' | 'chat' | 'answer' | 'summarise' | 'subagent'

export interface RouteInput {
  settings: RouterSettings
  intent: SessionIntent
  /** Sub-agent depth (0 = the user's session). */
  depth: number
  /** The model the user chose for the session. */
  sessionModel: string
  /** `agent.cheapModel` — the legacy single cheap model. */
  legacyCheap?: string
  planMode: boolean
  objective: string
  /** The very first work turn of the current objective, or the first after a new instruction. */
  freshObjective: boolean
  /** Tool names of the previous turn and whether they all succeeded. */
  lastTurn: { tools: string[]; allOk: boolean } | null
  /** The engine refused the previous completion claim. */
  verificationFailed: boolean
  /** Highest consecutive failure count of any tool. */
  failureStreak: number
  /** Tier used on the previous model call of this session, if any. */
  previousTier?: Tier
  /** Tiers the previous turns WANTED (before hysteresis), newest last. */
  recentDesired?: Tier[]
  /** What this call is for when it is not a normal turn. */
  purpose?: 'turn' | 'summary'
  /** Sub-agent flavour. */
  subagentKind?: 'explore' | 'work'
  /** Estimated tokens the conversation would put in front of a model that has not seen it yet. */
  contextTokens?: number
}

/** Above this, moving a work turn to another model re-bills the whole conversation uncached: not worth a cheaper rate. */
export const SWITCH_CONTEXT_LIMIT = 8_000

export interface RouteDecision {
  tier: Tier
  phase: Phase
  model: string
  provider?: string
  /** The tier the router wanted before hysteresis/floor/availability (for the next call's `recentDesired`). */
  desired: Tier
  /** True when the tier was raised because something went wrong. */
  escalated: boolean
  reason: string
}

const READ_TOOLS = new Set(['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'repo_map', 'read_symbol', 'tool_output', 'todo', 'session_search'])

const COMPLEX_EN = /\b(refactor|re-?architect|architecture|redesign|migrate|migration|rewrite|from scratch|race condition|deadlock|memory leak|security|vulnerabilit|concurrency|performance|optimi[sz]e|root cause|design (?:a|the) )/i
const COMPLEX_AR = /(إعادة هيكلة|هيكلة|معمارية|تصميم|ترحيل|من الصفر|أمان|ثغرة|أداء|السبب الجذري|تزامن)/

/** Cheap, deterministic read of how hard an objective looks. Conservative: standard unless clear. */
export function objectiveComplexity(objective: string): 'high' | 'normal' {
  const words = objective.trim().split(/\s+/).filter(Boolean).length
  const hits = (COMPLEX_EN.test(objective) ? 1 : 0) + (COMPLEX_AR.test(objective) ? 1 : 0)
  if (words >= 120 || (hits > 0 && words >= 15)) return 'high'
  return 'normal'
}

function resolve(tier: Tier, i: RouteInput): { target: TierTarget | null } {
  const t = i.settings.tiers[tier]
  if (t?.model) return { target: t }
  // Fallbacks keep v0.4.0 behaviour when nothing is configured.
  if (tier === 'cheap' && i.legacyCheap) return { target: { model: i.legacyCheap } }
  if (tier === 'cheap') return { target: null }
  // standard / strong default to the model the user picked.
  return { target: { model: i.sessionModel } }
}

/** Pick the model for one turn. Pure: same input, same answer. */
export function decideRoute(i: RouteInput): RouteDecision {
  const s = i.settings
  const sameAsSession = (model: string, provider?: string) => model === i.sessionModel && !provider

  // Router off: exactly the v0.4.0 behaviour.
  if (!s.enabled) {
    const cheapish = i.purpose === 'summary' || i.intent === 'chat' || i.intent === 'question' || i.depth > 0
    const cheap = cheapish && i.legacyCheap ? i.legacyCheap : ''
    const model = cheap || i.sessionModel
    return { tier: cheap ? 'cheap' : 'standard', phase: i.depth > 0 ? 'subagent' : 'edit', model, desired: cheap ? 'cheap' : 'standard', escalated: false, reason: 'router off — session model' }
  }

  let phase: Phase
  let desired: Tier
  let why: string
  let escalated = false
  const work = i.intent === 'task' || i.intent === 'goal'

  if (i.purpose === 'summary') {
    phase = 'summarise'
    desired = 'cheap'
    why = 'folding old turns into a summary needs no strong model'
  } else if (i.depth > 0) {
    phase = 'subagent'
    if (i.subagentKind === 'explore') {
      desired = 'cheap'
      why = 'read-only sub-agent (research)'
    } else {
      desired = 'standard'
      why = 'sub-agent that edits files'
    }
  } else if (i.intent === 'chat') {
    phase = 'chat'
    desired = 'cheap'
    why = 'small talk needs no strong model'
  } else if (i.intent === 'question') {
    phase = 'answer'
    desired = 'cheap'
    why = 'a question is answered by reading, not by the strong model'
  } else if (i.verificationFailed && s.escalateOnFailure) {
    phase = 'verify'
    desired = higherTier(maxTier(i.previousTier ?? 'standard', 'standard'))
    escalated = true
    why = 'the completion claim was refused — escalating'
  } else if (i.failureStreak >= 2 && s.escalateOnFailure) {
    phase = 'recover'
    desired = higherTier(maxTier(i.previousTier ?? 'standard', 'standard'))
    escalated = true
    why = `a tool failed ${i.failureStreak} times in a row — escalating`
  } else if (i.freshObjective || i.planMode) {
    phase = 'plan'
    const hard = objectiveComplexity(i.objective) === 'high'
    desired = hard ? 'strong' : 'standard'
    why = i.planMode ? 'plan mode — planning turn' : hard ? 'new complex objective — planning needs the strong tier' : 'new objective — planning turn'
  } else if (i.lastTurn && i.lastTurn.allOk && i.lastTurn.tools.length > 0 && i.lastTurn.tools.every((t) => READ_TOOLS.has(t))) {
    phase = 'search'
    desired = 'cheap'
    why = 'mechanical turn after read/search results'
  } else {
    phase = 'edit'
    desired = 'standard'
    why = 'working turn'
  }

  // Eco (opt-in, near the limit): one tier lower for mechanical/working turns.
  let eco = false
  if (s.eco && work && i.depth === 0 && (phase === 'search' || phase === 'edit' || phase === 'plan') && desired !== 'cheap') {
    desired = lowerTier(desired)
    eco = true
    why += ' · eco mode (near your limit) lowers it one tier'
  }

  let tier = desired
  // Hysteresis: a downgrade needs two consecutive turns that want the lower tier.
  if (i.previousTier && RANK[tier] < RANK[i.previousTier] && !escalated && work && i.depth === 0) {
    const last = i.recentDesired?.[i.recentDesired.length - 1]
    if ((i.contextTokens ?? 0) > SWITCH_CONTEXT_LIMIT) {
      tier = i.previousTier
      why += ` · staying on ${tier}: switching model would re-bill ~${Math.round((i.contextTokens ?? 0) / 1000)}k tokens uncached`
    } else if (!(last !== undefined && RANK[last] <= RANK[tier])) {
      tier = i.previousTier
      why += ` · staying on ${tier} one more turn (each model has its own cache)`
    }
  }

  // The floor: work turns never go below it. Summaries and conversation are not work.
  const floored = work && i.depth === 0 && i.purpose !== 'summary'
  if (floored && RANK[tier] < RANK[s.floor]) {
    why += ` · floor ${s.floor} keeps quality`
    tier = s.floor
  }
  // Sub-agents that edit also respect the floor.
  if (i.depth > 0 && i.subagentKind === 'work' && RANK[tier] < RANK[s.floor]) tier = s.floor

  // Resolve a model. If the tier has no model, climb to the nearest configured one
  // that does NOT violate the floor; the session model is always available.
  let { target } = resolve(tier, i)
  if (!target) {
    // cheap without a cheap model → use the session model, say so.
    target = { model: i.sessionModel }
    tier = 'standard'
    why += ' · no cheap model configured — using the session model'
  }
  // A tier that resolves to the session model while a lower tier was wanted is not a saving; report honestly.
  const name = sameAsSession(target.model, target.provider) ? `${target.model} (session model)` : target.model
  const reason = `${phase} · ${why} → ${tier} (${name})${eco ? ' [eco]' : ''}`

  return {
    tier,
    phase,
    model: target.model,
    ...(target.provider ? { provider: target.provider } : {}),
    desired,
    escalated,
    reason,
  }
}

/** Parse a tier target typed as "model" or "provider:model" is ambiguous (ollama tags), so the config uses objects; this helper only normalises strings. */
export function normaliseTarget(v: unknown): TierTarget | undefined {
  if (typeof v === 'string' && v.trim()) return { model: v.trim() }
  if (v && typeof v === 'object' && typeof (v as { model?: unknown }).model === 'string' && (v as { model: string }).model.trim()) {
    const o = v as { model: string; provider?: unknown }
    return { model: o.model.trim(), ...(typeof o.provider === 'string' && o.provider.trim() ? { provider: o.provider.trim() } : {}) }
  }
  return undefined
}
