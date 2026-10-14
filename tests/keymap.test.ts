import { describe, expect, it } from 'vitest'
import { resolveKey, type KeyEvent, type KeyContext } from '../src/tui/keymap.js'

/**
 * The keyboard interaction matrix: every documented shortcut, in every context
 * where the interface can receive it. These tests pin the exact behavior that
 * regressed in the TUI incident (Ctrl+K dead-locking the welcome screen, Tab
 * switching the WRONG session's mode, Esc doing nothing under an overlay).
 */

const key = (over: Partial<KeyEvent> = {}): KeyEvent => ({ ...over })

const ctx = (over: Partial<KeyContext> = {}): KeyContext => ({
  view: 'session',
  overlay: null,
  running: false,
  escArmed: false,
  ...over,
})

const welcome = ctx({ view: 'home' })
const session = ctx({ view: 'session' })

describe('resolveKey — global chords', () => {
  it('Ctrl+C quits in EVERY context, including under overlays', () => {
    const contexts = [
      welcome,
      session,
      ctx({ overlay: 'palette' }),
      ctx({ overlay: 'sessions' }),
      ctx({ overlay: 'providers' }),
      ctx({ overlay: 'settings' }),
      ctx({ running: true }),
    ]
    for (const c of contexts) {
      expect(resolveKey('c', key({ ctrl: true }), c)).toEqual({ type: 'quit' })
    }
  })

  it('Ctrl+K opens the palette on the welcome screen AND in a session', () => {
    // The dead-keyboard bug: Ctrl+K used to set an overlay state that swallowed
    // every key while nothing was rendered.
    expect(resolveKey('k', key({ ctrl: true }), welcome)).toEqual({ type: 'open-palette' })
    expect(resolveKey('k', key({ ctrl: true }), session)).toEqual({ type: 'open-palette' })
  })

  it('Ctrl+N opens the start screen from a session (and is inert on it)', () => {
    expect(resolveKey('n', key({ ctrl: true }), session)).toEqual({ type: 'open-home' })
    expect(resolveKey('n', key({ ctrl: true }), welcome)).toEqual({ type: 'none' })
  })

  it('Ctrl+B toggles the sidebar only in a session view (no invisible state flips)', () => {
    expect(resolveKey('b', key({ ctrl: true }), session)).toEqual({ type: 'toggle-sidebar' })
    expect(resolveKey('b', key({ ctrl: true }), welcome)).toEqual({ type: 'none' })
  })

  it('Ctrl+W closes a tab only in a session view', () => {
    expect(resolveKey('w', key({ ctrl: true }), session)).toEqual({ type: 'close-tab' })
    expect(resolveKey('w', key({ ctrl: true }), welcome)).toEqual({ type: 'none' })
  })

  it('Ctrl+G jumps to the latest entry only in a session view', () => {
    expect(resolveKey('g', key({ ctrl: true }), session)).toEqual({ type: 'scroll-latest' })
    // Where no session exists yet, Ctrl+G switches the DRAFT completion
    // policy shown in the welcome box / objective entry.
    expect(resolveKey('g', key({ ctrl: true }), welcome)).toEqual({ type: 'toggle-kind' })
  })

  it('Alt+← / Alt+→ switch tabs only in a session view', () => {
    expect(resolveKey('', key({ meta: true, leftArrow: true }), session)).toEqual({ type: 'switch-tab', dir: -1 })
    expect(resolveKey('', key({ meta: true, rightArrow: true }), session)).toEqual({ type: 'switch-tab', dir: 1 })
    expect(resolveKey('', key({ meta: true, leftArrow: true }), welcome)).toEqual({ type: 'none' })
  })

  it('unhandled Ctrl or Alt chords are silent — never typed as text', () => {
    // Ctrl+A arrives as raw 'a' with ctrl:true; it must not insert a letter.
    expect(resolveKey('a', key({ ctrl: true }), session)).toEqual({ type: 'none' })
    expect(resolveKey('x', key({ meta: true }), session)).toEqual({ type: 'none' })
    expect(resolveKey('', key({ meta: true }), ctx({ overlay: 'new-session' }))).toEqual({ type: 'none' })
  })
})

describe('resolveKey — Tab (PLAN/BUILD)', () => {
  it('toggles the mode on the welcome screen (draft)', () => {
    expect(resolveKey('\t', key({ tab: true }), welcome)).toEqual({ type: 'toggle-mode' })
  })

  it('toggles the ACTIVE session mode in a session view', () => {
    expect(resolveKey('\t', key({ tab: true }), session)).toEqual({ type: 'toggle-mode' })
  })

  it('is owned by the overlays where Tab means something else (scope toggle)', () => {
    expect(resolveKey('\t', key({ tab: true }), ctx({ overlay: 'sessions' }))).toEqual({ type: 'overlay-input' })
    expect(resolveKey('\t', key({ tab: true }), ctx({ overlay: 'palette' }))).toEqual({ type: 'overlay-input' })
  })
})

describe('resolveKey — text entry', () => {
  it('Enter submits in every entry context', () => {
    expect(resolveKey('\r', key({ return: true }), welcome)).toEqual({ type: 'submit' })
    expect(resolveKey('\r', key({ return: true }), session)).toEqual({ type: 'submit' })
    expect(resolveKey('\r', key({ return: true }), ctx({ overlay: 'new-session' }))).toEqual({ type: 'submit' })
    // A running session submits a follow-up — never a second engine start.
    expect(resolveKey('\r', key({ return: true }), ctx({ running: true }))).toEqual({ type: 'submit' })
  })

  it('Backspace (ink classifies \\x7f as key.delete) deletes one character', () => {
    for (const c of [welcome, session, ctx({ overlay: 'new-session' })]) {
      expect(resolveKey('\x7f', key({ delete: true }), c)).toEqual({ type: 'delete-back' })
      expect(resolveKey('\b', key({ backspace: true }), c)).toEqual({ type: 'delete-back' })
    }
  })

  it('Ctrl+J inserts a newline and NEVER submits (terminals send a bare "\\n")', () => {
    expect(resolveKey('\n', key({}), welcome)).toEqual({ type: 'newline' })
    expect(resolveKey('\n', key({}), session)).toEqual({ type: 'newline' })
    expect(resolveKey('\n', key({}), ctx({ overlay: 'new-session' }))).toEqual({ type: 'newline' })
  })

  it('a multi-character paste keeps its text and line breaks (printable branch)', () => {
    const action = resolveKey('line1\nline2', key({}), session)
    expect(action).toEqual({ type: 'text', text: 'line1\nline2' })
    // Enter is a LONE \r; a paste chunk that merely contains \r is still text.
    expect(resolveKey('a\rb', key({}), welcome)).toEqual({ type: 'text', text: 'a\rb' })
  })

  it('plain characters become text in every entry context', () => {
    expect(resolveKey('a', key({}), welcome)).toEqual({ type: 'text', text: 'a' })
    expect(resolveKey('a', key({}), session)).toEqual({ type: 'text', text: 'a' })
    expect(resolveKey('a', key({}), ctx({ overlay: 'new-session' }))).toEqual({ type: 'text', text: 'a' })
  })
})

describe('resolveKey — overlays own the keyboard', () => {
  const keys: Array<[string, KeyEvent]> = [
    ['a', key({})],
    ['\r', key({ return: true })],
    ['\t', key({ tab: true })],
    ['', key({ upArrow: true })],
    ['', key({ downArrow: true })],
    ['\x7f', key({ delete: true })],
    // Esc is deliberately NOT in this list: it is the app-level close action
    // (asserted in its own test below), and Ctrl+C quits — both must work
    // even before the overlay's own subscription attaches.
    ['b', key({ ctrl: true })],
    ['w', key({ ctrl: true })],
  ]

  it('palette and sessions overlays swallow typing, Enter, Tab, arrows and chords', () => {
    for (const overlay of ['palette', 'sessions'] as const) {
      for (const [raw, k] of keys) {
        expect(resolveKey(raw, k, ctx({ overlay })).type).toBe('overlay-input')
      }
    }
  })

  it('the start screen: Esc / Ctrl+W go back only when it was opened over a session', () => {
    const overSession = ctx({ view: 'home', canLeaveHome: true })
    expect(resolveKey('', key({ escape: true }), overSession)).toEqual({ type: 'close-home' })
    expect(resolveKey('w', key({ ctrl: true }), overSession)).toEqual({ type: 'close-home' })
    expect(resolveKey('', key({ meta: true, rightArrow: true }), overSession)).toEqual({ type: 'switch-tab', dir: 1 })
    // First launch: nowhere to go back to.
    expect(resolveKey('', key({ escape: true }), welcome)).toEqual({ type: 'none' })
    expect(resolveKey('w', key({ ctrl: true }), welcome)).toEqual({ type: 'none' })
    // Arrows move through the recent list; typing still works.
    expect(resolveKey('', key({ downArrow: true }), welcome)).toEqual({ type: 'home-move', dir: 1 })
    expect(resolveKey('z', key({}), welcome)).toEqual({ type: 'text', text: 'z' })
    expect(resolveKey('\r', key({ return: true }), welcome)).toEqual({ type: 'submit' })
  })

  it('help closes with Esc like the palette', () => {
    expect(resolveKey('', key({ escape: true }), ctx({ overlay: 'help' }))).toEqual({ type: 'close-overlay', overlay: 'help' })
  })

  it('Esc closes the open overlay', () => {
    expect(resolveKey('\x1b', key({ escape: true }), ctx({ overlay: 'palette' }))).toEqual({
      type: 'close-overlay',
      overlay: 'palette',
    })
    expect(resolveKey('\x1b', key({ escape: true }), ctx({ overlay: 'sessions' }))).toEqual({
      type: 'close-overlay',
      overlay: 'sessions',
    })
  })
})

describe('resolveKey — Escape interrupt (double press)', () => {
  it('arms on the first press, interrupts on the second, only while running', () => {
    expect(resolveKey('\x1b', key({ escape: true }), ctx({ running: true, escArmed: false }))).toEqual({
      type: 'arm-interrupt',
    })
    expect(resolveKey('\x1b', key({ escape: true }), ctx({ running: true, escArmed: true }))).toEqual({
      type: 'interrupt',
    })
    expect(resolveKey('\x1b', key({ escape: true }), ctx({ running: false }))).toEqual({ type: 'none' })
  })
})

describe('resolveKey — scrollback', () => {
  it('PgUp/PgDn move the viewport only in a session view', () => {
    expect(resolveKey('', key({ pageUp: true }), session)).toEqual({ type: 'scroll', dir: -1 })
    expect(resolveKey('', key({ pageDown: true }), session)).toEqual({ type: 'scroll', dir: 1 })
    expect(resolveKey('', key({ pageUp: true }), welcome)).toEqual({ type: 'none' })
  })
})

describe('resolveKey — provider manager overlay', () => {
  it('owns every key (including Esc, which means "back" inside it) except Ctrl+C', () => {
    for (const overlay of ['providers', 'models'] as const) {
      const c = ctx({ overlay })
      expect(resolveKey('', key({ escape: true }), c)).toEqual({ type: 'overlay-input' })
      expect(resolveKey('t', key(), c)).toEqual({ type: 'overlay-input' })
      expect(resolveKey('k', key({ ctrl: true }), c)).toEqual({ type: 'overlay-input' })
      expect(resolveKey('c', key({ ctrl: true }), c)).toEqual({ type: 'quit' })
    }
  })
})

describe('resolveKey — mouse and arrow scrolling', () => {
  it('wheel reports scroll the transcript; they are never typed as text', () => {
    expect(resolveKey('[<64;10;5M', key(), session)).toEqual({ type: 'wheel', delta: -1 })
    expect(resolveKey('[<65;10;5M', key(), session)).toEqual({ type: 'wheel', delta: 1 })
    // Several reports can arrive in one chunk.
    expect(resolveKey('[<65;10;5M\u001b[<65;10;5M\u001b[<65;1;1M', key(), session)).toEqual({ type: 'wheel', delta: 3 })
    // Clicks, drags and releases are swallowed silently.
    expect(resolveKey('[<0;10;5M', key(), session)).toEqual({ type: 'none' })
    expect(resolveKey('[<0;10;5m', key(), session)).toEqual({ type: 'none' })
    expect(resolveKey('[<32;10;5M', key(), welcome)).toEqual({ type: 'none' })
    expect(resolveKey('[<64;10;5M', key(), ctx({ overlay: 'palette' }))).toEqual({ type: 'none' })
  })

  it('↑/↓ scroll a session by a line', () => {
    expect(resolveKey('', key({ upArrow: true }), session)).toEqual({ type: 'scroll-line', dir: -1 })
    expect(resolveKey('', key({ downArrow: true }), session)).toEqual({ type: 'scroll-line', dir: 1 })
  })

  it('Ctrl+O opens settings anywhere', () => {
    expect(resolveKey('o', key({ ctrl: true }), session)).toEqual({ type: 'open-settings' })
    expect(resolveKey('o', key({ ctrl: true }), welcome)).toEqual({ type: 'open-settings' })
  })
})
