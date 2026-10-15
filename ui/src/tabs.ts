/**
 * Open session tabs and the optional second (split) session. Pure and tested.
 * `open` is the tab order the person arranged; `active` is the session in the main pane;
 * `split` is a second open tab shown beside it (never the same as `active`).
 */

export interface TabsState {
  open: string[]
  active: string | null
  split: string | null
}

export const EMPTY_TABS: TabsState = { open: [], active: null, split: null }
export const MAX_TABS = 12
const KEY = 'vara.tabs.v1'

const norm = (s: TabsState): TabsState => {
  const open = [...new Set(s.open)].slice(0, MAX_TABS)
  const active = s.active && open.includes(s.active) ? s.active : null
  const split = s.split && open.includes(s.split) && s.split !== active ? s.split : null
  return { open, active, split }
}

/** Show a session: add its tab when it is not open yet and make it the main one. */
export function openTab(s: TabsState, id: string): TabsState {
  if (s.split === id) return norm({ ...s, split: s.active, active: id })
  const open = s.open.includes(id) ? s.open : [...s.open, id]
  // Opening a 13th tab drops the oldest one that is not on screen.
  while (open.length > MAX_TABS) {
    const drop = open.findIndex((x) => x !== id && x !== s.split)
    if (drop < 0) break
    open.splice(drop, 1)
  }
  return norm({ open, active: id, split: s.split })
}

/** Close a tab. Returns the new state; `active` moves to the neighbour (or the split session). */
export function closeTab(s: TabsState, id: string): TabsState {
  const i = s.open.indexOf(id)
  if (i < 0) return s
  const open = s.open.filter((x) => x !== id)
  if (s.split === id) return norm({ open, active: s.active, split: null })
  if (s.active !== id) return norm({ ...s, open })
  const next = s.split ?? open[Math.min(i, open.length - 1)] ?? null
  return norm({ open, active: next, split: s.split === next ? null : s.split })
}

/** Drag-and-drop reorder: move the tab `from` so it sits where `to` is. */
export function moveTab(s: TabsState, from: string, to: string): TabsState {
  const a = s.open.indexOf(from)
  const b = s.open.indexOf(to)
  if (a < 0 || b < 0 || a === b) return s
  const open = [...s.open]
  open.splice(a, 1)
  open.splice(b, 0, from)
  return norm({ ...s, open })
}

/** Show `id` beside the main session (it must be open; it is opened when it is not). */
export function splitWith(s: TabsState, id: string): TabsState {
  if (!s.active || id === s.active) return s
  const open = s.open.includes(id) ? s.open : [...s.open, id]
  return norm({ open, active: s.active, split: id })
}

export const unsplit = (s: TabsState): TabsState => norm({ ...s, split: null })

/** Swap which of the two shown sessions is the main one. */
export function swapSplit(s: TabsState): TabsState {
  return s.split && s.active ? norm({ ...s, active: s.split, split: s.active }) : s
}

/** Alt+Arrow: the tab `dir` steps away from the active one, wrapping. */
export function stepTab(s: TabsState, dir: -1 | 1): string | null {
  if (!s.open.length) return null
  const i = s.active ? s.open.indexOf(s.active) : -1
  return s.open[(i + dir + s.open.length) % s.open.length] ?? null
}

/** Forget tabs whose session no longer exists (only once the list has loaded). */
export function pruneTabs(s: TabsState, valid: Set<string>): TabsState {
  const open = s.open.filter((id) => valid.has(id))
  return open.length === s.open.length ? s : norm({ open, active: s.active, split: s.split })
}

export function parseTabs(raw: string | null | undefined): TabsState {
  if (!raw) return EMPTY_TABS
  try {
    const j = JSON.parse(raw) as Partial<TabsState>
    const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && /^[\w-]{1,80}$/.test(x)) : [])
    return norm({ open: ids(j.open), active: typeof j.active === 'string' ? j.active : null, split: typeof j.split === 'string' ? j.split : null })
  } catch {
    return EMPTY_TABS
  }
}

export function loadTabs(): TabsState {
  try {
    return parseTabs(localStorage.getItem(KEY))
  } catch {
    return EMPTY_TABS
  }
}

export function storeTabs(s: TabsState): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* kept for this tab only */
  }
}
