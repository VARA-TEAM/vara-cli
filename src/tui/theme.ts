import type { SessionState } from '../core/types.js'

/**
 * Color tokens for the whole TUI. Components read `theme.<token>` at render
 * time; `applyTheme()` swaps the palette in place and the app re-renders, so a
 * theme change is live. Hex colors (chalk downsamples on 256-color terminals).
 * No emoji anywhere: their cell width differs between terminals and breaks
 * borders and alignment.
 */
export interface Palette {
  name: string
  label: string
  /** Primary accent: brand, focus, prompt. */
  brand: string
  /** Secondary accent: links, hints, chat. */
  accent: string
  /** The user's own messages. */
  user: string
  /** The assistant's bullet. */
  assistant: string
  ok: string
  warn: string
  err: string
  info: string
  /** Secondary text. */
  muted: string
  /** Borders and rules. */
  border: string
  /** Text on top of a colored chip. */
  onAccent: string
  plan: string
  build: string
  task: string
  goal: string
  chat: string
  question: string
}

type Base = Omit<Palette, 'assistant' | 'plan' | 'build' | 'task' | 'goal' | 'chat' | 'question'> &
  Partial<Pick<Palette, 'assistant' | 'plan' | 'build' | 'task' | 'goal' | 'chat' | 'question'>>

function palette(b: Base): Palette {
  return {
    assistant: b.brand,
    plan: b.warn,
    build: b.ok,
    task: b.info,
    goal: b.user,
    chat: b.accent,
    question: b.accent,
    ...b,
  }
}

export const THEMES: Palette[] = [
  palette({ name: 'vara', label: 'VARA (violet)', brand: '#8B6CFF', accent: '#BCAEFF', user: '#D6A8F0', ok: '#8FD19E', warn: '#F0A64B', err: '#F2788A', info: '#7FB0FF', muted: '#8A8399', border: '#3A3550', onAccent: '#FFFFFF' }),
  palette({ name: 'tokyo-night', label: 'Tokyo Night', brand: '#7AA2F7', accent: '#7DCFFF', user: '#BB9AF7', ok: '#9ECE6A', warn: '#E0AF68', err: '#F7768E', info: '#7AA2F7', muted: '#565F89', border: '#3B4261', onAccent: '#1A1B26' }),
  palette({ name: 'catppuccin', label: 'Catppuccin Mocha', brand: '#CBA6F7', accent: '#89DCEB', user: '#F5C2E7', ok: '#A6E3A1', warn: '#F9E2AF', err: '#F38BA8', info: '#89B4FA', muted: '#7F849C', border: '#45475A', onAccent: '#1E1E2E' }),
  palette({ name: 'dracula', label: 'Dracula', brand: '#BD93F9', accent: '#8BE9FD', user: '#FF79C6', ok: '#50FA7B', warn: '#F1FA8C', err: '#FF5555', info: '#8BE9FD', muted: '#6272A4', border: '#44475A', onAccent: '#282A36' }),
  palette({ name: 'nord', label: 'Nord', brand: '#88C0D0', accent: '#8FBCBB', user: '#B48EAD', ok: '#A3BE8C', warn: '#EBCB8B', err: '#BF616A', info: '#81A1C1', muted: '#616E88', border: '#434C5E', onAccent: '#2E3440' }),
  palette({ name: 'gruvbox', label: 'Gruvbox', brand: '#FE8019', accent: '#8EC07C', user: '#D3869B', ok: '#B8BB26', warn: '#FABD2F', err: '#FB4934', info: '#83A598', muted: '#928374', border: '#504945', onAccent: '#282828' }),
  palette({ name: 'rose-pine', label: 'Rosé Pine', brand: '#EBBCBA', accent: '#9CCFD8', user: '#C4A7E7', ok: '#9CCFD8', warn: '#F6C177', err: '#EB6F92', info: '#C4A7E7', muted: '#6E6A86', border: '#403D52', onAccent: '#191724' }),
  palette({ name: 'github-light', label: 'Light', brand: '#C2410C', accent: '#0E7490', user: '#7C3AED', ok: '#15803D', warn: '#B45309', err: '#B91C1C', info: '#1D4ED8', muted: '#6B7280', border: '#D0D7DE', onAccent: '#FFFFFF' }),
  palette({ name: 'mono', label: 'Monochrome', brand: '#F5F5F5', accent: '#D4D4D4', user: '#E5E5E5', ok: '#D4D4D4', warn: '#BFBFBF', err: '#FFFFFF', info: '#D4D4D4', muted: '#7C7C7C', border: '#4A4A4A', onAccent: '#111111' }),
]

/** The live palette. Mutated in place by applyTheme (components read it each render). */
export const theme: Palette = { ...THEMES[0]! }

export function findTheme(name: string): Palette | undefined {
  return THEMES.find((t) => t.name === name)
}

/** Switch the live palette. Unknown names fall back to the default. Returns the applied name. */
export function applyTheme(name: string): string {
  const next = findTheme(name) ?? THEMES[0]!
  Object.assign(theme, next)
  return next.name
}

export function stateColor(state: SessionState): string {
  switch (state) {
    case 'running':
    case 'completed':
      return theme.ok
    case 'ready':
      return theme.accent
    case 'waiting_user':
    case 'paused':
      return theme.warn
    case 'interrupted':
    case 'failed':
      return theme.err
    default:
      return theme.muted
  }
}

export const STATE_LABEL: Record<SessionState, string> = {
  idle: 'idle',
  running: 'working',
  ready: 'ready',
  waiting_user: 'needs you',
  paused: 'paused',
  interrupted: 'interrupted',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
}

export const glyph = {
  bar: '▌',
  dot: '●',
  ok: '✓',
  fail: '✗',
  pending: '◌',
  warn: '⚠',
  prompt: '❯',
  sep: '·',
  rule: '─',
} as const

export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const

/** Rows a block of text occupies when wrapped to `width` columns. */
export function wrappedRows(text: string, width: number): number {
  const w = Math.max(10, width)
  let rows = 0
  for (const line of text.split('\n')) rows += Math.max(1, Math.ceil(line.length / w))
  return rows
}

/** Keep only the last `maxRows` visual rows of streaming text. */
export function tailRows(text: string, width: number, maxRows: number): string {
  const lines = text.split('\n')
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0 && used < maxRows; i--) {
    const l = lines[i] ?? ''
    const r = Math.max(1, Math.ceil(l.length / Math.max(10, width)))
    if (used + r > maxRows && out.length > 0) break
    out.unshift(l)
    used += r
  }
  return out.join('\n')
}
