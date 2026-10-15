import { describe, expect, it } from 'vitest'
import { DEFAULT_ROUTER, decideRoute, objectiveComplexity, type RouteInput, type RouterSettings } from '../src/core/router.js'

const tiers = { strong: { model: 'big' }, standard: { model: 'mid' }, cheap: { model: 'small' } }
const settings = (over: Partial<RouterSettings> = {}): RouterSettings => ({ ...DEFAULT_ROUTER, tiers, ...over })
const input = (over: Partial<RouteInput> = {}): RouteInput => ({
  settings: settings(),
  intent: 'task',
  depth: 0,
  sessionModel: 'big',
  planMode: false,
  objective: 'fix the typo in README',
  freshObjective: false,
  lastTurn: null,
  verificationFailed: false,
  failureStreak: 0,
  ...over,
})

describe('router - which tier for which turn', () => {
  it('small talk and questions use the cheap tier, with a reason', () => {
    const chat = decideRoute(input({ intent: 'chat' }))
    expect(chat).toMatchObject({ tier: 'cheap', model: 'small', phase: 'chat' })
    expect(chat.reason).toContain('small')
    expect(decideRoute(input({ intent: 'question' }))).toMatchObject({ tier: 'cheap', model: 'small', phase: 'answer' })
  })

  it('the first work turn plans on standard, and on strong for a clearly complex objective', () => {
    expect(decideRoute(input({ freshObjective: true })).tier).toBe('standard')
    const hard = decideRoute(
      input({
        freshObjective: true,
        objective:
          'Refactor the whole session store to be re-architected for concurrency and migrate every caller, keeping all tests green and documenting each decision carefully',
      }),
    )
    expect(hard).toMatchObject({ tier: 'strong', model: 'big', phase: 'plan' })
  })

  it('a normal working turn is standard; mechanical read turns stay standard while the floor is standard', () => {
    expect(decideRoute(input()).tier).toBe('standard')
    const afterReads = decideRoute(input({ lastTurn: { tools: ['read_file', 'grep'], allOk: true } }))
    expect(afterReads.phase).toBe('search')
    expect(afterReads.tier).toBe('standard') // clamped by the floor
    expect(afterReads.reason).toContain('floor standard')
  })

  it('with the floor lowered, mechanical turns go cheap, but only after two turns that want it (cache hysteresis)', () => {
    const s = settings({ floor: 'cheap' })
    const first = decideRoute(input({ settings: s, previousTier: 'standard', recentDesired: ['standard'], lastTurn: { tools: ['read_file'], allOk: true } }))
    expect(first.tier).toBe('standard')
    expect(first.reason).toContain('one more turn')
    const second = decideRoute(input({ settings: s, previousTier: 'standard', recentDesired: ['standard', 'cheap'], lastTurn: { tools: ['read_file'], allOk: true } }))
    expect(second.tier).toBe('cheap')
  })

  it('does not downgrade a long conversation to another model: the switch would re-bill it uncached', () => {
    const s = settings({ floor: 'cheap' })
    const d = decideRoute(input({ settings: s, previousTier: 'standard', recentDesired: ['cheap', 'cheap'], contextTokens: 40_000, lastTurn: { tools: ['read_file'], allOk: true } }))
    expect(d.tier).toBe('standard')
    expect(d.reason).toContain('re-bill')
    expect(decideRoute(input({ settings: s, previousTier: 'standard', recentDesired: ['cheap', 'cheap'], contextTokens: 2_000, lastTurn: { tools: ['read_file'], allOk: true } })).tier).toBe('cheap')
  })

  it('a refused completion and repeated tool failures escalate, immediately', () => {
    const v = decideRoute(input({ verificationFailed: true, previousTier: 'standard' }))
    expect(v).toMatchObject({ tier: 'strong', phase: 'verify', escalated: true })
    const r = decideRoute(input({ failureStreak: 2, previousTier: 'standard' }))
    expect(r).toMatchObject({ tier: 'strong', phase: 'recover', escalated: true })
    expect(decideRoute(input({ verificationFailed: true, settings: settings({ escalateOnFailure: false }) })).escalated).toBe(false)
  })

  it('NEVER goes below the user floor: not in eco mode, not for mechanical turns, not for sub-agents that edit', () => {
    const rank = { cheap: 0, standard: 1, strong: 2 }
    for (const floor of ['standard', 'strong'] as const) {
      for (const phaseInput of [
        input({ lastTurn: { tools: ['grep'], allOk: true } }),
        input(),
        input({ freshObjective: true }),
        input({ depth: 1, subagentKind: 'work', intent: 'task' }),
      ]) {
        const d = decideRoute({ ...phaseInput, settings: settings({ floor, eco: true }), previousTier: 'strong', recentDesired: ['cheap', 'cheap'] })
        expect(rank[d.tier]).toBeGreaterThanOrEqual(rank[floor])
      }
    }
  })

  it('eco mode lowers one tier for routine turns (floor permitting) and says so', () => {
    const d = decideRoute(input({ settings: settings({ floor: 'cheap', eco: true }), previousTier: 'cheap', recentDesired: ['cheap'] }))
    expect(d.tier).toBe('cheap')
    expect(d.reason).toContain('eco')
    expect(decideRoute(input({ settings: settings({ floor: 'standard', eco: true }) })).tier).toBe('standard')
  })

  it('sub-agents: research is cheap, editing follows the floor', () => {
    expect(decideRoute(input({ depth: 1, subagentKind: 'explore', intent: 'question' }))).toMatchObject({ tier: 'cheap', phase: 'subagent' })
    expect(decideRoute(input({ depth: 1, subagentKind: 'work' })).tier).toBe('standard')
  })

  it('summaries are cheap, and a missing cheap model falls back to the session model honestly', () => {
    expect(decideRoute(input({ purpose: 'summary' })).model).toBe('small')
    const none = decideRoute(input({ settings: { ...DEFAULT_ROUTER }, intent: 'chat' }))
    expect(none.model).toBe('big')
    expect(none.tier).toBe('standard')
    expect(none.reason).toContain('no cheap model')
  })

  it('with nothing configured it behaves like v0.4.0: cheapModel for chat/question/sub-agents, the session model otherwise', () => {
    const base = { settings: { ...DEFAULT_ROUTER }, legacyCheap: 'legacy-mini' }
    expect(decideRoute(input({ ...base, intent: 'chat' })).model).toBe('legacy-mini')
    expect(decideRoute(input({ ...base, intent: 'question' })).model).toBe('legacy-mini')
    expect(decideRoute(input({ ...base, freshObjective: true })).model).toBe('big')
    expect(decideRoute(input({ ...base, lastTurn: { tools: ['read_file'], allOk: true } })).model).toBe('big')
  })

  it('a tier can name a model on another provider', () => {
    const d = decideRoute(input({ intent: 'chat', settings: settings({ tiers: { ...tiers, cheap: { model: 'gpt-4o-mini', provider: 'openai' } } }) }))
    expect(d).toMatchObject({ model: 'gpt-4o-mini', provider: 'openai' })
  })

  it('router off reproduces the old behaviour exactly', () => {
    const d = decideRoute(input({ settings: { ...DEFAULT_ROUTER, enabled: false }, intent: 'chat', legacyCheap: 'legacy-mini' }))
    expect(d.model).toBe('legacy-mini')
    expect(decideRoute(input({ settings: { ...DEFAULT_ROUTER, enabled: false } })).model).toBe('big')
  })

  it('objective complexity is conservative', () => {
    expect(objectiveComplexity('fix the typo')).toBe('normal')
    expect(objectiveComplexity('refactor it')).toBe('normal') // a keyword alone on a short ask is not enough
    expect(objectiveComplexity('أعد هيكلة نظام الجلسات بالكامل وانقل كل المستدعين إليه مع الحفاظ على الاختبارات خضراء وتوثيق القرارات')).toBe('high')
  })
})
