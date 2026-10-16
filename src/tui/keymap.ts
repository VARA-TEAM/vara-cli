import { parseClick } from './clicks.js'
/**
 * Single authoritative keyboard-routing policy for the TUI.
 *
 * Every keystroke is resolved here into ONE action before any state changes,
 * so the behavior per context is testable without rendering, and two handlers
 * can never compete for the same key. `App.tsx` only performs the side effect
 * of the resolved action.
 *
 * Contexts:
 *   - home:     the start screen (no session yet, or a new tab via Ctrl+N).
 *   - session:  a session is active.
 *   - overlays: palette / sessions own the keyboard (Esc closes them here);
 *     providers / models / settings are multi-screen forms where Esc means
 *     "back", so they alone decide when they close. Ctrl+C always quits.
 */

/** Structural view of ink's `Key` (booleans only) — keeps this module pure. */
export interface KeyEvent {
  ctrl?: boolean
  meta?: boolean
  tab?: boolean
  return?: boolean
  escape?: boolean
  backspace?: boolean
  delete?: boolean
  pageUp?: boolean
  pageDown?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
  upArrow?: boolean
  downArrow?: boolean
}

export type Overlay = null | 'palette' | 'sessions' | 'help' | 'providers' | 'models' | 'settings' | 'mcp' | 'agents'

export interface KeyContext {
  view: 'home' | 'session'
  overlay: Overlay
  running: boolean
  escArmed: boolean
  /** Home opened over existing sessions (Ctrl+N): Esc / Ctrl+W go back. */
  canLeaveHome?: boolean
  /** The prompt is empty (arrow keys then navigate instead of editing). */
  inputEmpty?: boolean
}

export type KeyAction =
  | { type: 'quit' }
  | { type: 'overlay-input' }
  | { type: 'close-overlay'; overlay: Exclude<Overlay, null> }
  | { type: 'open-palette' }
  | { type: 'open-settings' }
  | { type: 'open-home' }
  | { type: 'close-home' }
  | { type: 'home-move'; dir: -1 | 1 }
  | { type: 'arm-interrupt' }
  | { type: 'interrupt' }
  | { type: 'toggle-sidebar' }
  | { type: 'close-tab' }
  | { type: 'switch-tab'; dir: -1 | 1 }
  | { type: 'scroll'; dir: -1 | 1 }
  | { type: 'scroll-line'; dir: -1 | 1 }
  | { type: 'wheel'; delta: number }
  | { type: 'click'; x: number; y: number }
  | { type: 'scroll-latest' }
  | { type: 'toggle-mode' }
  | { type: 'toggle-kind' }
  | { type: 'submit' }
  | { type: 'newline' }
  | { type: 'delete-back' }
  | { type: 'text'; text: string }
  | { type: 'none' }

/** SGR mouse reports as ink delivers them (leading ESC already stripped). */
const MOUSE_RE = /\[<(\d+);\d+;\d+[Mm]/g

/**
 * Mouse reports → wheel delta (negative = up). Returns null when `raw` is not
 * a mouse report. Clicks and drags resolve to 0 so they are never typed.
 */
export function parseMouse(raw: string): number | null {
  if (!raw.startsWith('[<') && !raw.startsWith('\u001b[<')) return null
  let delta = 0
  let any = false
  for (const m of raw.matchAll(MOUSE_RE)) {
    any = true
    const button = Number(m[1])
    if (button === 64) delta -= 1
    else if (button === 65) delta += 1
  }
  return any ? delta : null
}

/**
 * Resolve one keystroke. Order is the priority model:
 *   1. Ctrl+C always saves + quits (even under an overlay).
 *   2. Mouse reports never become text.
 *   3. Overlays own the keyboard while open.
 *   4. Escape: back from home, or arm/execute the interrupt.
 *   5. Global chords fire only where they have a real effect.
 *   6. Text entry (submit / backspace / newline / printable) is uniform.
 */
export function resolveKey(raw: string, key: KeyEvent, ctx: KeyContext): KeyAction {
  // ink delivers Ctrl+letter as ctrl:true with the letter as raw.
  const ctrlChar = key.ctrl ? raw.toLowerCase() : ''

  // 1. Ctrl+C — save + quit, everywhere, always.
  if (ctrlChar === 'c') return { type: 'quit' }

  // 2. Mouse: the wheel scrolls the transcript; everything else is ignored.
  const wheel = parseMouse(raw)
  if (wheel !== null) {
    const click = parseClick(raw)
    if (click && !ctx.overlay) return { type: 'click', ...click }
    if (ctx.overlay || ctx.view !== 'session' || wheel === 0) return { type: 'none' }
    return { type: 'wheel', delta: wheel }
  }

  // 3. Overlays.
  if (ctx.overlay === 'providers' || ctx.overlay === 'models' || ctx.overlay === 'settings' || ctx.overlay === 'mcp' || ctx.overlay === 'agents') return { type: 'overlay-input' }
  if (ctx.overlay === 'palette' || ctx.overlay === 'sessions' || ctx.overlay === 'help') {
    // Esc is resolved here so it closes even before the overlay's own
    // subscription attaches (its onClose does the same thing, idempotently).
    if (key.escape) return { type: 'close-overlay', overlay: ctx.overlay }
    return { type: 'overlay-input' }
  }

  // 4. Escape.
  if (key.escape) {
    if (ctx.view === 'home') return ctx.canLeaveHome ? { type: 'close-home' } : { type: 'none' }
    if (!ctx.running) return { type: 'none' }
    return ctx.escArmed ? { type: 'interrupt' } : { type: 'arm-interrupt' }
  }

  // 5. Global chords — only where they actually do something.
  if (ctrlChar === 'k') return { type: 'open-palette' }
  if (ctrlChar === 'o') return { type: 'open-settings' }
  if (ctrlChar === 'n') return ctx.view === 'session' ? { type: 'open-home' } : { type: 'none' }
  if (ctrlChar === 'b') return ctx.view === 'session' ? { type: 'toggle-sidebar' } : { type: 'none' }
  if (ctrlChar === 'w') {
    if (ctx.view === 'session') return { type: 'close-tab' }
    return ctx.canLeaveHome ? { type: 'close-home' } : { type: 'none' }
  }
  if (key.meta && (key.leftArrow || key.rightArrow)) {
    return ctx.view === 'session' || ctx.canLeaveHome ? { type: 'switch-tab', dir: key.leftArrow ? -1 : 1 } : { type: 'none' }
  }
  if (key.pageUp) return ctx.view === 'session' ? { type: 'scroll', dir: -1 } : { type: 'none' }
  if (key.pageDown) return ctx.view === 'session' ? { type: 'scroll', dir: 1 } : { type: 'none' }
  if (key.upArrow || key.downArrow) {
    const dir = key.upArrow ? -1 : 1
    if (ctx.view === 'home') return { type: 'home-move', dir }
    // Arrow keys scroll the transcript (also what terminals send for the
    // wheel in "alternate scroll" mode when mouse reporting is off).
    return { type: 'scroll-line', dir }
  }
  // Ctrl+G: jump to the latest entry in a session; on the home screen it
  // cycles the draft kind (auto → task → goal).
  if (ctrlChar === 'g') return ctx.view === 'session' ? { type: 'scroll-latest' } : { type: 'toggle-kind' }

  // 6. Text entry — identical on the home screen and in a session.
  if (key.tab) return { type: 'toggle-mode' }
  if (key.return) return { type: 'submit' }
  if (key.backspace || key.delete) return { type: 'delete-back' }
  // Ctrl+J inserts a newline; a paste arrives as one printable chunk and keeps
  // its line breaks. Only a lone "\r" is Enter (key.return).
  if (raw === '\n') return { type: 'newline' }
  if (raw && !key.ctrl && !key.meta) return { type: 'text', text: raw }
  return { type: 'none' }
}
