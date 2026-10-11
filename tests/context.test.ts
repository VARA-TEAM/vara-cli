import { describe, expect, it } from 'vitest'
import { estimateTokens, estimateSessionTokens, formatTokens, resolveWindow, contextStatus } from '../src/core/context.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import type { Session } from '../src/core/types.js'

describe('context window resolution', () => {
  it('user override wins over everything (Configured)', () => {
    expect(resolveWindow('gpt-4o', { windowTokens: 200_000, maxOutputTokens: 4096 })).toEqual({
      windowTokens: 200_000,
      source: 'configured',
    })
  })

  it('detects known models from the registry', () => {
    expect(resolveWindow('gpt-4o', { maxOutputTokens: 4096 }).source).toBe('detected')
    expect(resolveWindow('gpt-4o', { maxOutputTokens: 4096 }).windowTokens).toBe(128_000)
    expect(resolveWindow('claude-3-5-sonnet', { maxOutputTokens: 4096 }).windowTokens).toBe(200_000)
  })

  it('never invents a number for unknown models — uses the marked fallback', () => {
    const r = resolveWindow('deepseek-ai/deepseek-v4.1-flash', { maxOutputTokens: 4096 })
    expect(r.source).toBe('fallback')
    expect(r.windowTokens).toBe(64_000)
  })

  it('reserves output and safety margin out of the request budget', () => {
    const status = contextStatus(
      { config: { model: 'gpt-4o' } } as Session,
      { windowTokens: 100_000, maxOutputTokens: 4_000 },
    )
    expect(status.requestBudgetTokens).toBe(94_000)
  })
})

describe('token estimation', () => {
  it('estimates roughly four chars per token', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('')).toBe(0)
  })

  it('formats thousands compactly', () => {
    expect(formatTokens(18_000)).toBe('18k')
    expect(formatTokens(900)).toBe('900')
  })

  it('counts objective, requirements and transcript for a session', () => {
    const session: Session = createSession(
      CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'abcdefgh', cwd: 'C:\\tmp\\vara-ctx-test' }),
      DEFAULT_CONFIG,
    )
    session.transcript.push({ role: 'user', content: 'ijklmnop' })
    // objective(8 chars) + requirement text + transcript(8 chars) + 2000-char overhead
    expect(estimateSessionTokens(session)).toBeGreaterThan(500)
  })
})
