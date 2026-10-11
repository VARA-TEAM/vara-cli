/**
 * Single authoritative keyboard-routing policy for the TUI.
 *
 * Every keystroke is resolved here into ONE action before any state changes,
 * so the behavior per context is testable without rendering, and two handlers
 * can never compete for the same key. `App.tsx` only performs the side effect
 * of the resolved action.
 *
 * Contexts:
 *   - welcome:  no session yet (the landing screen).
 *   - session:  a session is active.
 *   - new-session overlay: a focused mini-form for the next objective — global
 *     shortcuts step aside so typing never triggers a tab close or a mode
 *     switch of the WRONG session.
 *   - palette / sessions overlays: their own components own the keyboard; the
 *     app must not act on those keys (Ctrl+C still quits — it is the one
 *     global chord that survives every context).
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
}

export type Overlay = null | 'palette' | 'sessions' | 'new-session'

export interface KeyContext {
  view: 'welcome' | 'session'
  overlay: Overlay
  running: boolean
  escArmed: boolean
}

export type KeyAction =
  | { type: 'quit' }
  | { type: 'overlay-input' }
  | { type: 'close-overlay'; overlay: Exclude<Overlay, null> }
  | { type: 'open-palette' }
  | { type: 'open-new-session' }
  | { type: 'arm-interrupt' }
  | { type: 'interrupt' }
  | { type: 'toggle-sidebar' }
  | { type: 'close-tab' }
  | { type: 'switch-tab'; dir: -1 | 1 }
  | { type: 'scroll'; dir: -1 | 1 }
  | { type: 'scroll-latest' }
  | { type: 'toggle-mode' }
  | { type: 'toggle-kind' }
  | { type: 'submit' }
  | { type: 'newline' }
  | { type: 'delete-back' }
  | { type: 'text'; text: string }
  | { type: 'none' }

/**
 * Resolve one keystroke. Order is the priority model:
 *   1. Ctrl+C always saves + quits (even under an overlay).
 *   2. listOverlays own the keyboard while open — Esc always closes them at
 *      the app level, so a not-yet-attached overlay subscription can never
 *      swallow it.
 *   3. The new-objective entry is a focused form (Tab = its own draft mode).
 *   4. Escape closes the overlay, or arms/executes the interrupt.
 *   5. Global chords fire only in contexts where they have a real effect —
 *      a shortcut that does nothing must resolve to 'none', never to a
 *      silent state change behind the user's back.
 *   6. Text entry (submit / backspace / newline / printable) is uniform.
 */
export function resolveKey(raw: string, key: KeyEvent, ctx: KeyContext): KeyAction {
  // ink delivers Ctrl+letter as ctrl:true with the letter as raw.
  const ctrlChar = key.ctrl ? raw.toLowerCase() : ''

  // 1. Ctrl+C — save + quit, everywhere, always.
  if (ctrlChar === 'c') return { type: 'quit' }

  // 2. Palette and session browser own the keyboard while open — except Esc,
  // which is the APP's documented close action: resolving it here means it
  // closes the overlay even when the overlay's own subscription has not
  // attached yet (its onClose would do the same thing, idempotently).
  if (ctx.overlay === 'palette' || ctx.overlay === 'sessions') {
    if (key.escape) return { type: 'close-overlay', overlay: ctx.overlay }
    return { type: 'overlay-input' }
  }

  // 3. Focused "new objective" entry.
  if (ctx.overlay === 'new-session') {
    if (key.escape) return { type: 'close-overlay', overlay: 'new-session' }
    if (key.return) return { type: 'submit' }
    if (key.tab) return { type: 'toggle-mode' } // the mode of the session being created
    if (ctrlChar === 'g') return { type: 'toggle-kind' } // its completion policy too
    if (key.backspace || key.delete) return { type: 'delete-back' }
    // Ctrl+J: terminals send it as a bare "\n" — never a submit (Enter is "\r").
    if (raw === '\n') return { type: 'newline' }
    if (raw && !key.ctrl && !key.meta) return { type: 'text', text: raw }
    return { type: 'none' }
  }

  // 4. Escape.
  if (key.escape) {
    if (ctx.overlay) return { type: 'close-overlay', overlay: ctx.overlay }
    if (!ctx.running) return { type: 'none' }
    return ctx.escArmed ? { type: 'interrupt' } : { type: 'arm-interrupt' }
  }

  // 5. Global chords — only where they actually do something.
  if (ctrlChar === 'k') return { type: 'open-palette' } // works pre-session too
  if (ctrlChar === 'n') return ctx.view === 'session' ? { type: 'open-new-session' } : { type: 'none' }
  if (ctrlChar === 'b') return ctx.view === 'session' ? { type: 'toggle-sidebar' } : { type: 'none' }
  if (ctrlChar === 'w') return ctx.view === 'session' ? { type: 'close-tab' } : { type: 'none' }
  if (key.meta && (key.leftArrow || key.rightArrow)) {
    return ctx.view === 'session' ? { type: 'switch-tab', dir: key.leftArrow ? -1 : 1 } : { type: 'none' }
  }
  if (key.pageUp) return ctx.view === 'session' ? { type: 'scroll', dir: -1 } : { type: 'none' }
  if (key.pageDown) return ctx.view === 'session' ? { type: 'scroll', dir: 1 } : { type: 'none' }
  // Ctrl+G: jump to the latest entry in a session; where there is no session
  // yet it switches the DRAFT completion policy (task ↔ goal) shown live in
  // the welcome box / objective entry.
  if (ctrlChar === 'g') return ctx.view === 'session' ? { type: 'scroll-latest' } : { type: 'toggle-kind' }

  // 6. Text entry — identical in the welcome screen and the session view.
  if (key.tab) return { type: 'toggle-mode' }
  if (key.return) return { type: 'submit' }
  if (key.backspace || key.delete) return { type: 'delete-back' }
  // Ctrl+J inserts a newline; a paste arrives as one printable chunk and keeps
  // its line breaks. Only a lone "\r" is Enter (key.return).
  if (raw === '\n') return { type: 'newline' }
  if (raw && !key.ctrl && !key.meta) return { type: 'text', text: raw }
  return { type: 'none' }
}
