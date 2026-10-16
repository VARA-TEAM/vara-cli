import { describe, expect, it } from 'vitest'
import { suggestions } from '../src/tui/complete.js'
import { resolveKey, type KeyContext } from '../src/tui/keymap.js'

const src = {
  commands: [
    { name: '/compact', description: 'fold' },
    { name: '/cost', description: 'cost' },
    { name: '/model', description: 'model' },
  ],
  skills: ['code-review', 'cost-audit'],
  mcpServers: ['github'],
}

describe('prompt completion', () => {
  it('completes /commands and /skills from the first word', () => {
    expect(suggestions('/co', src).map((s) => s.label)).toEqual(['/compact', '/cost', '/code-review', '/cost-audit'])
    expect(suggestions('/mo', src)[0]!.apply).toBe('/model ')
    expect(suggestions('hello /co', src)).toEqual([])
  })
  it('completes @skill, @server and the special words, keeping what came before', () => {
    const s = suggestions('please use @co', src)
    expect(s.map((x) => x.label)).toEqual(['@code-review', '@cost-audit'])
    expect(s[0]!.apply).toBe('please use @code-review ')
    expect(suggestions('@gi', src)[0]!.apply).toBe('@github ')
    expect(suggestions('@ag', src)[0]!.label).toBe('@agents')
    expect(suggestions('mail me@example', src)).toEqual([])
  })
  it('Tab completes when there is something to complete, and still flips the mode otherwise', () => {
    const ctx = (hasCompletion: boolean) => ({ view: 'session', overlay: null, running: false, escArmed: false, inputEmpty: false, hasCompletion }) as KeyContext
    expect(resolveKey('', { tab: true }, ctx(true))).toEqual({ type: 'complete' })
    expect(resolveKey('', { tab: true }, ctx(false))).toEqual({ type: 'toggle-mode' })
  })
})
