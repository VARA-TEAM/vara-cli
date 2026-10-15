/**
 * Workbench layout math: pane sizes, limits, presets, persistence. Pure (no DOM), so it is unit-tested.
 * Sizes are CSS pixels. "start" / "end" are logical: the sidebar sits at the inline start, the side
 * panel at the inline end, so the same numbers work in left-to-right and right-to-left.
 */

export type PaneId = 'nav' | 'side' | 'dock'
export type SideTab = 'proof' | 'cost' | 'agents' | 'files' | 'tools'
export type DockTab = 'output' | 'preview' | 'events'
export type PresetId = 'focus' | 'review' | 'swarm' | 'preview'

export interface PaneState {
  size: number
  open: boolean
}

export interface LayoutState {
  nav: PaneState
  side: PaneState
  dock: PaneState
  /** Share of the editor width given to the first session when two are shown side by side. */
  split: number
  sideTab: SideTab
  dockTab: DockTab
}

export interface Limits {
  min: number
  max: number
  def: number
}

export const LIMITS: Record<PaneId, Limits> = {
  nav: { min: 200, max: 440, def: 268 },
  side: { min: 280, max: 720, def: 344 },
  dock: { min: 120, max: 640, def: 232 },
}
/** The conversation never gets narrower than this; panes give way first. */
export const MIN_EDITOR = 360
export const MIN_EDITOR_HEIGHT = 220
export const SPLIT_MIN = 0.22
export const SPLIT_MAX = 0.78
/** Below this width the panes become drawers and tabs. */
export const NARROW = 900
/** Below this width only one session shows (no split view). */
export const NO_SPLIT = 1100
export const KEY_STEP = 16
export const KEY_STEP_BIG = 64

export const SIDE_TABS: SideTab[] = ['proof', 'cost', 'agents', 'files', 'tools']
export const DOCK_TABS: DockTab[] = ['output', 'preview', 'events']

export const DEFAULT_LAYOUT: LayoutState = {
  nav: { size: LIMITS.nav.def, open: true },
  side: { size: LIMITS.side.def, open: true },
  dock: { size: LIMITS.dock.def, open: false },
  split: 0.5,
  sideTab: 'proof',
  dockTab: 'output',
}

const KEY = 'vara.layout.v1'

export const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export function clampSize(pane: PaneId, size: number): number {
  const l = LIMITS[pane]
  return Math.round(clamp(size, l.min, l.max))
}

export function clampSplit(v: number): number {
  return Math.round(clamp(v, SPLIT_MIN, SPLIT_MAX) * 1000) / 1000
}

/**
 * New size from a drag. `delta` is the pointer movement along the x axis (right = positive).
 * A pane on the inline START grows when the pointer moves toward the inline end: to the right in
 * LTR, to the left in RTL. The side panel is the opposite. The dock grows upward (negative y delta),
 * so callers pass `-deltaY` for it.
 */
export function sizeFromDrag(pane: PaneId, startSize: number, delta: number, rtl: boolean): number {
  const toEnd = rtl ? -delta : delta
  const growth = pane === 'nav' ? toEnd : pane === 'side' ? -toEnd : delta
  return clampSize(pane, startSize + growth)
}

/** A key pressed on a splitter. Returns the new size, or null when the key means nothing here. */
export function sizeFromKey(pane: PaneId, size: number, key: string, shift: boolean, rtl: boolean): number | null {
  const step = shift ? KEY_STEP_BIG : KEY_STEP
  const l = LIMITS[pane]
  if (key === 'Home') return l.min
  if (key === 'End') return l.max
  if (key === 'Enter') return l.def
  if (pane === 'dock') {
    if (key === 'ArrowUp') return clampSize(pane, size + step)
    if (key === 'ArrowDown') return clampSize(pane, size - step)
    return null
  }
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  // "toward the inline end" = ArrowRight in LTR, ArrowLeft in RTL
  const toEnd = (key === 'ArrowRight') !== rtl
  const growth = pane === 'nav' ? (toEnd ? step : -step) : toEnd ? -step : step
  return clampSize(pane, size + growth)
}

/** The same for the divider between two sessions (a fraction of the editor width). */
export function splitFromKey(split: number, key: string, shift: boolean, rtl: boolean): number | null {
  const step = shift ? 0.1 : 0.03
  if (key === 'Home') return SPLIT_MIN
  if (key === 'End') return SPLIT_MAX
  if (key === 'Enter') return 0.5
  if (key !== 'ArrowLeft' && key !== 'ArrowRight') return null
  const toEnd = (key === 'ArrowRight') !== rtl
  return clampSplit(split + (toEnd ? step : -step))
}

export function splitFromDrag(startSplit: number, delta: number, editorWidth: number, rtl: boolean): number {
  if (editorWidth <= 0) return startSplit
  return clampSplit(startSplit + (rtl ? -delta : delta) / editorWidth)
}

export type Mode = 'wide' | 'medium' | 'narrow'
export const modeFor = (width: number): Mode => (width < NARROW ? 'narrow' : width < 1280 ? 'medium' : 'wide')
export const canSplit = (width: number): boolean => width >= NO_SPLIT

/**
 * Make the layout fit a window: if the open panes would squeeze the conversation below MIN_EDITOR, the
 * side panel gives way first, then the sidebar, down to their minimums. The stored sizes are not
 * changed (only what is shown), so enlarging the window brings the layout back.
 */
export function fitToWindow(layout: LayoutState, width: number, height: number): { nav: number; side: number; dock: number } {
  let nav = layout.nav.open ? layout.nav.size : 0
  let side = layout.side.open ? layout.side.size : 0
  let dock = layout.dock.open ? layout.dock.size : 0
  const over = (): number => nav + side + MIN_EDITOR - width
  let o = over()
  if (o > 0 && side) {
    const take = Math.min(o, side - LIMITS.side.min)
    side -= Math.max(0, take)
    o = over()
  }
  if (o > 0 && nav) {
    const take = Math.min(o, nav - LIMITS.nav.min)
    nav -= Math.max(0, take)
    o = over()
  }
  if (o > 0 && side) side = Math.max(0, side - o) // still too tight: the panel shrinks below its minimum rather than hiding
  const maxDock = Math.max(0, height - MIN_EDITOR_HEIGHT)
  dock = Math.min(dock, maxDock)
  return { nav, side, dock }
}

export interface Preset {
  id: PresetId
  layout: Pick<LayoutState, 'nav' | 'side' | 'dock' | 'sideTab' | 'dockTab'>
}

/** Layout presets. Each is a complete answer to "what am I doing right now". */
export const PRESETS: Preset[] = [
  { id: 'focus', layout: { nav: { size: LIMITS.nav.def, open: false }, side: { size: LIMITS.side.def, open: false }, dock: { size: LIMITS.dock.def, open: false }, sideTab: 'proof', dockTab: 'output' } },
  { id: 'review', layout: { nav: { size: LIMITS.nav.def, open: true }, side: { size: 400, open: true }, dock: { size: LIMITS.dock.def, open: false }, sideTab: 'proof', dockTab: 'output' } },
  { id: 'swarm', layout: { nav: { size: 232, open: true }, side: { size: 520, open: true }, dock: { size: 200, open: true }, sideTab: 'agents', dockTab: 'output' } },
  { id: 'preview', layout: { nav: { size: LIMITS.nav.def, open: true }, side: { size: 360, open: true }, dock: { size: 360, open: true }, sideTab: 'proof', dockTab: 'preview' } },
]

export function applyPreset(layout: LayoutState, id: PresetId): LayoutState {
  const p = PRESETS.find((x) => x.id === id)
  return p ? { ...layout, ...p.layout } : layout
}

/** Which preset (if any) the current layout equals. */
export function matchPreset(layout: LayoutState): PresetId | null {
  for (const p of PRESETS) {
    const l = p.layout
    if (l.nav.open === layout.nav.open && l.side.open === layout.side.open && l.dock.open === layout.dock.open && (!l.nav.open || l.nav.size === layout.nav.size) && (!l.side.open || l.side.size === layout.side.size) && (!l.dock.open || l.dock.size === layout.dock.size)) return p.id
  }
  return null
}

export function resetPane(layout: LayoutState, pane: PaneId): LayoutState {
  return { ...layout, [pane]: { ...layout[pane], size: LIMITS[pane].def } }
}

export function setPane(layout: LayoutState, pane: PaneId, patch: Partial<PaneState>): LayoutState {
  const cur = layout[pane]
  return { ...layout, [pane]: { size: clampSize(pane, patch.size ?? cur.size), open: patch.open ?? cur.open } }
}

export function togglePane(layout: LayoutState, pane: PaneId): LayoutState {
  return setPane(layout, pane, { open: !layout[pane].open })
}

/** Open the side panel on a given tab (or close it when it is already showing that tab). */
export function showSide(layout: LayoutState, tab: SideTab, toggle = false): LayoutState {
  if (toggle && layout.side.open && layout.sideTab === tab) return setPane(layout, 'side', { open: false })
  return { ...setPane(layout, 'side', { open: true }), sideTab: tab }
}

export function showDock(layout: LayoutState, tab: DockTab, toggle = false): LayoutState {
  if (toggle && layout.dock.open && layout.dockTab === tab) return setPane(layout, 'dock', { open: false })
  return { ...setPane(layout, 'dock', { open: true }), dockTab: tab }
}

/** Read a stored layout. Anything wrong with it falls back to the default for that field. */
export function parseLayout(raw: string | null | undefined): LayoutState {
  if (!raw) return DEFAULT_LAYOUT
  let j: unknown
  try {
    j = JSON.parse(raw)
  } catch {
    return DEFAULT_LAYOUT
  }
  if (!j || typeof j !== 'object') return DEFAULT_LAYOUT
  const o = j as Record<string, unknown>
  const pane = (id: PaneId): PaneState => {
    const p = (o[id] ?? {}) as Record<string, unknown>
    return { size: clampSize(id, finite(p['size'], LIMITS[id].def)), open: typeof p['open'] === 'boolean' ? p['open'] : DEFAULT_LAYOUT[id].open }
  }
  return {
    nav: pane('nav'),
    side: pane('side'),
    dock: pane('dock'),
    split: clampSplit(finite(o['split'], 0.5)),
    sideTab: (SIDE_TABS as string[]).includes(String(o['sideTab'])) ? (o['sideTab'] as SideTab) : DEFAULT_LAYOUT.sideTab,
    dockTab: (DOCK_TABS as string[]).includes(String(o['dockTab'])) ? (o['dockTab'] as DockTab) : DEFAULT_LAYOUT.dockTab,
  }
}

export const serializeLayout = (l: LayoutState): string => JSON.stringify(l)

export function loadLayout(): LayoutState {
  try {
    return parseLayout(localStorage.getItem(KEY))
  } catch {
    return DEFAULT_LAYOUT
  }
}

export function storeLayout(l: LayoutState): void {
  try {
    localStorage.setItem(KEY, serializeLayout(l))
  } catch {
    /* private mode: the layout lasts for this tab only */
  }
}
