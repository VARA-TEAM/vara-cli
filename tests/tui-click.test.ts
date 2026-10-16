import { describe, expect, it } from 'vitest'
import { parseClick } from '../src/tui/clicks.js'
import { resolveKey, type KeyContext } from '../src/tui/keymap.js'

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({ view: 'session', overlay: null, running: false, escArmed: false, canLeaveHome: false, inputEmpty: true, ...over }) as KeyContext
const noKey = {} as never

describe('mouse clicks in the TUI', () => {
  it('reads a left-button press as a 0-based cell and ignores release, wheel and other buttons', () => {
    expect(parseClick('[<0;5;3M')).toEqual({ x: 4, y: 2 })
    expect(parseClick('[<0;5;3m')).toBeNull()
    expect(parseClick('[<64;5;3M')).toBeNull()
    expect(parseClick('[<2;5;3M')).toBeNull()
  })
  it('turns a press into a click action, but never under an overlay and never into typed text', () => {
    expect(resolveKey('[<0;10;1M', noKey, ctx())).toEqual({ type: 'click', x: 9, y: 0 })
    expect(resolveKey('[<0;10;1M', noKey, ctx({ overlay: 'palette' }))).toEqual({ type: 'none' })
    expect(resolveKey('[<0;10;1m', noKey, ctx())).toEqual({ type: 'none' })
  })
})
