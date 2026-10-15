import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ApiError, api as call } from '../api'
import { useRegisterCommands, type Cmd } from '../commands'
import { useT } from '../i18n'
import {
  DEFAULT_LAYOUT,
  LIMITS,
  PRESETS,
  applyPreset,
  canSplit,
  fitToWindow,
  loadLayout,
  matchPreset,
  modeFor,
  resetPane,
  setPane,
  showDock,
  showSide,
  sizeFromDrag,
  sizeFromKey,
  splitFromDrag,
  splitFromKey,
  storeLayout,
  togglePane,
  type DockTab,
  type LayoutState,
  type PresetId,
  type SideTab,
} from '../layout'
import { closeTab as closeTabIn, loadTabs, moveTab, openTab, splitWith, stepTab, storeTabs, swapSplit, unsplit, type TabsState } from '../tabs'
import type { SessionSummary } from '../types'
import type { Route } from './Sidebar'
import { Splitter } from './Splitter'
import { StatusBar } from './StatusBar'
import { TabBar } from './TabBar'

/** What a session pane tells the status bar about itself. */
export interface SessionInfo {
  title: string
  state: string
  model?: string
  costUsd: number | null
  costPartial: boolean
  modelCalls: number
  /** Agents running now / in the latest swarm run. */
  agentsRunning: number
  agentsTotal: number
  connected: boolean
}

export interface WorkbenchApi {
  layout: LayoutState
  narrow: boolean
  /** Effective visibility (on narrow screens: the drawer state). */
  sideOpen: boolean
  dockOpen: boolean
  sideSlot: HTMLElement | null
  dockSlot: HTMLElement | null
  focused: string | null
  setFocused: (id: string) => void
  openSide: (tab: SideTab, toggle?: boolean) => void
  openDock: (tab: DockTab, toggle?: boolean) => void
  closeSide: () => void
  closeDock: () => void
  setSideTab: (tab: SideTab) => void
  setDockTab: (tab: DockTab) => void
  setInfo: (id: string, info: SessionInfo | null) => void
  closeTab: (id: string) => void
  tabs: TabsState
}

export const WorkbenchContext = createContext<WorkbenchApi | null>(null)
/** Null outside the workbench (tests, isolated renders). */
export const useWorkbench = (): WorkbenchApi | null => useContext(WorkbenchContext)

function useViewport(): { w: number; h: number } {
  const [v, setV] = useState(() => ({ w: typeof window === 'undefined' ? 1440 : window.innerWidth, h: typeof window === 'undefined' ? 900 : window.innerHeight }))
  useEffect(() => {
    const on = (): void => setV((cur) => (cur.w === window.innerWidth && cur.h === window.innerHeight ? cur : { w: window.innerWidth, h: window.innerHeight }))
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return v
}

const isRtl = (): boolean => document.documentElement.dir === 'rtl'

/**
 * The workbench: sidebar | tabs and one or two sessions | side panel, with a bottom dock and a status
 * bar. Sizes are draggable, keyboard-resizable, collapsible, remembered per browser, and reset by a
 * double click. On narrow screens the side panel and dock become drawers and the sidebar a menu.
 */
export function Workbench({
  sessions,
  route,
  onRoute,
  nav,
  navOpen,
  page,
  renderSession,
  folderName,
  sessionsLoaded,
}: {
  sessions: SessionSummary[]
  route: Route
  onRoute: (r: Route) => void
  nav: (x: { openIds: string[]; onSplit: (id: string) => void }) => ReactNode
  /** Narrow screens only: the sidebar drawer is open. */
  navOpen: boolean
  /** Any non-session page (home, team, settings). */
  page: ReactNode
  renderSession: (id: string, role: 'main' | 'split') => ReactNode
  folderName?: string
  /** The session list has arrived (so a missing session really is missing). */
  sessionsLoaded?: boolean
}) {
  const t = useT()
  const vp = useViewport()
  const [layout, setLayout] = useState<LayoutState>(loadLayout)
  const [tabs, setTabs] = useState<TabsState>(loadTabs)
  const [info, setInfos] = useState<Record<string, SessionInfo>>({})
  const [sideSlot, setSideSlot] = useState<HTMLElement | null>(null)
  const [dockSlot, setDockSlot] = useState<HTMLElement | null>(null)
  const [focused, setFocusedState] = useState<string | null>(null)
  const [drawer, setDrawer] = useState<{ side: boolean; dock: boolean }>({ side: false, dock: false })
  const [dragTab, setDragTab] = useState<string | null>(null)
  const editors = useRef<HTMLDivElement>(null)
  const narrow = modeFor(vp.w) === 'narrow'
  const inSession = route.page === 'session'

  // Remember the layout and the open tabs (debounced: dragging updates them continuously).
  useEffect(() => {
    const id = setTimeout(() => storeLayout(layout), 250)
    return () => clearTimeout(id)
  }, [layout])
  useEffect(() => storeTabs(tabs), [tabs])

  // The route decides which session is in the main pane.
  useEffect(() => {
    if (route.page === 'session') setTabs((s) => (s.active === route.id && s.open.includes(route.id) ? s : openTab(s, route.id)))
  }, [route])

  const update = useCallback((fn: (l: LayoutState) => LayoutState) => setLayout((l) => fn(l)), [])
  const activate = useCallback((id: string) => onRoute({ page: 'session', id }), [onRoute])

  const closeTab = useCallback(
    (id: string) => {
      const next = closeTabIn(tabs, id)
      setTabs(next)
      if (route.page === 'session' && route.id === id) onRoute(next.active ? { page: 'session', id: next.active } : { page: 'home' })
    },
    [tabs, route, onRoute],
  )

  const sideOpen = narrow ? drawer.side : layout.side.open
  const dockOpen = narrow ? drawer.dock : layout.dock.open
  const showSplit = !!tabs.split && canSplit(vp.w) && inSession
  const mainId = route.page === 'session' ? route.id : null
  const splitId = showSplit ? tabs.split : null
  const focusId = focused && (focused === mainId || focused === splitId) ? focused : mainId

  const api: WorkbenchApi = useMemo(
    () => ({
      layout,
      narrow,
      sideOpen,
      dockOpen,
      sideSlot,
      dockSlot,
      focused: focusId,
      setFocused: setFocusedState,
      openSide: (tab, toggle) => {
        if (narrow) setDrawer((d) => ({ ...d, side: toggle && d.side && layout.sideTab === tab ? false : true }))
        update((l) => (narrow ? { ...l, sideTab: tab } : showSide(l, tab, toggle)))
      },
      openDock: (tab, toggle) => {
        if (narrow) setDrawer((d) => ({ ...d, dock: toggle && d.dock && layout.dockTab === tab ? false : true }))
        update((l) => (narrow ? { ...l, dockTab: tab } : showDock(l, tab, toggle)))
      },
      closeSide: () => (narrow ? setDrawer((d) => ({ ...d, side: false })) : update((l) => setPane(l, 'side', { open: false }))),
      closeDock: () => (narrow ? setDrawer((d) => ({ ...d, dock: false })) : update((l) => setPane(l, 'dock', { open: false }))),
      setSideTab: (tab) => update((l) => ({ ...l, sideTab: tab })),
      setDockTab: (tab) => update((l) => ({ ...l, dockTab: tab })),
      setInfo: (id, v) =>
        setInfos((cur) => {
          if (!v) {
            if (!(id in cur)) return cur
            const { [id]: _drop, ...rest } = cur
            return rest
          }
          const old = cur[id]
          return old && JSON.stringify(old) === JSON.stringify(v) ? cur : { ...cur, [id]: v }
        }),
      closeTab,
      tabs,
    }),
    [layout, narrow, sideOpen, dockOpen, sideSlot, dockSlot, focusId, update, closeTab, tabs],
  )

  // `/sessions` brings the sidebar (and its filter) into view.
  useEffect(() => {
    const on = (): void => update((l) => setPane(l, 'nav', { open: true }))
    window.addEventListener('vara:sessions', on)
    return () => window.removeEventListener('vara:sessions', on)
  }, [update])

  // A tab whose session no longer exists (deleted, another host) is dropped, once, when the list is known.
  const checked = useRef(new Set<string>())
  useEffect(() => {
    if (!sessionsLoaded) return
    for (const id of tabs.open) {
      if (checked.current.has(id) || sessions.some((s) => s.id === id)) continue
      checked.current.add(id)
      call('GET', `/api/sessions/${encodeURIComponent(id)}`).catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 404) setTabs((s) => closeTabIn(s, id))
      })
    }
  }, [sessionsLoaded, sessions, tabs.open])

  /* ---- keyboard ---- */
  useEffect(() => {
    const on = (e: KeyboardEvent): void => {
      const mod = e.ctrlKey || e.metaKey
      if (e.altKey && !mod && !e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        // Alt+←/→ walks the open tabs (the terminal's keys); the browser's "back" is not wanted here.
        const id = stepTab(tabs, (e.key === 'ArrowRight') !== isRtl() ? 1 : -1)
        if (id) (e.preventDefault(), activate(id))
      } else if (e.altKey && e.shiftKey && !mod && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && tabs.active) {
        // Alt+Shift+←/→ moves the active tab (the keyboard way to reorder).
        const to = stepTab(tabs, (e.key === 'ArrowRight') !== isRtl() ? 1 : -1)
        if (to && to !== tabs.active) (e.preventDefault(), setTabs((s) => moveTab(s, s.active!, to)))
      } else if (e.altKey && !mod && e.key.toLowerCase() === 'w' && tabs.active) {
        e.preventDefault()
        closeTab(tabs.active)
      } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') {
        e.preventDefault()
        update((l) => togglePane(l, 'nav'))
      } else if (mod && !e.shiftKey && !e.altKey && e.key === '.') {
        e.preventDefault()
        if (inSession) api.openSide(layout.sideTab, true)
      } else if (mod && !e.shiftKey && !e.altKey && e.key === '`') {
        e.preventDefault()
        if (inSession) api.openDock(layout.dockTab, true)
      } else if (mod && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        if (inSession) api.openSide('agents', true)
      } else if (mod && !e.shiftKey && !e.altKey && e.key === '\\') {
        e.preventDefault()
        if (tabs.split) setTabs(unsplit)
        else {
          const other = tabs.open.find((x) => x !== tabs.active)
          if (other) setTabs((s) => splitWith(s, other))
        }
      }
    }
    window.addEventListener('keydown', on)
    return () => window.removeEventListener('keydown', on)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabs, layout, inSession, narrow, activate, closeTab, update])

  /* ---- commands (palette and slash) ---- */
  const cmds: Cmd[] = useMemo(() => {
    const list: Cmd[] = []
    const add = (c: Cmd): void => void list.push(c)
    for (const p of PRESETS) add({ id: `wb:preset:${p.id}`, slash: `layout-${p.id}`, group: 'layout', title: `${t('wb_layout')}: ${t(`wb_preset_${p.id}` as 'wb_preset_focus')}`, run: () => (setDrawer({ side: false, dock: false }), update((l) => applyPreset(l, p.id))) })
    add({ id: 'wb:reset', slash: 'layout-reset', group: 'layout', title: t('wb_resetLayout'), run: () => update(() => DEFAULT_LAYOUT) })
    add({ id: 'wb:nav', group: 'layout', title: t('wb_navToggle'), shortcut: 'Ctrl B', run: () => update((l) => togglePane(l, 'nav')) })
    if (inSession) {
      add({ id: 'wb:side', group: 'layout', title: t('details'), shortcut: 'Ctrl .', run: () => api.openSide(layout.sideTab, true) })
      add({ id: 'wb:dock', slash: 'dock', group: 'layout', title: t('wb_dock'), shortcut: 'Ctrl `', run: () => api.openDock(layout.dockTab, true) })
      add({ id: 'wb:agents', slash: 'agents', group: 'session', title: t('ag_open'), description: t('ag_openHelp'), shortcut: 'Ctrl Shift A', run: () => api.openSide('agents') })
      if (tabs.split) {
        add({ id: 'wb:unsplit', slash: 'unsplit', group: 'layout', title: t('wb_unsplit'), shortcut: 'Ctrl \\', run: () => setTabs(unsplit) })
        add({ id: 'wb:swap', group: 'layout', title: t('wb_swap'), run: () => setTabs(swapSplit) })
      } else if (tabs.open.length > 1) {
        add({ id: 'wb:split', slash: 'split', group: 'layout', title: t('wb_split'), shortcut: 'Ctrl \\', run: () => setTabs((s) => splitWith(s, s.open.find((x) => x !== s.active) ?? '')) })
      }
    }
    if (tabs.active) add({ id: 'wb:close', slash: 'close', group: 'go', title: t('wb_closeTab'), shortcut: 'Alt W', run: () => closeTab(tabs.active!) })
    if (tabs.open.length > 1) {
      add({ id: 'wb:next', group: 'go', title: t('wb_nextTab'), shortcut: 'Alt →', run: () => (stepTab(tabs, 1) ? activate(stepTab(tabs, 1)!) : undefined) })
      add({ id: 'wb:prev', group: 'go', title: t('wb_prevTab'), shortcut: 'Alt ←', run: () => (stepTab(tabs, -1) ? activate(stepTab(tabs, -1)!) : undefined) })
    }
    return list
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t, inSession, layout.sideTab, layout.dockTab, tabs, narrow, activate, closeTab, update])
  useRegisterCommands('workbench', cmds)

  /* ---- geometry ---- */
  const fit = fitToWindow(layout, vp.w, vp.h - 28 /* status bar */ - 38 /* tab bar */)
  const navShown = !narrow && layout.nav.open
  const sideShown = inSession && (narrow ? drawer.side : layout.side.open)
  const dockShown = inSession && (narrow ? drawer.dock : layout.dock.open)
  const rtl = isRtl()
  const preset: PresetId | null = matchPreset(layout)

  const edDrop = (zone: 'here' | 'beside', e: React.DragEvent): void => {
    e.preventDefault()
    const id = e.dataTransfer.getData('text/vara-tab') || dragTab
    setDragTab(null)
    if (!id) return
    if (zone === 'here') activate(id)
    else if (id !== tabs.active) setTabs((s) => splitWith(s, id))
  }

  const editorBody = (
    <div className={`wb-editors${showSplit ? ' is-split' : ''}`} ref={editors}>
      {inSession && mainId ? (
        <>
          <div className={`wb-editor${focusId === mainId && showSplit ? ' is-focus' : ''}`} style={showSplit ? { flexBasis: `${layout.split * 100}%` } : undefined} onMouseDownCapture={() => setFocusedState(mainId)} onFocusCapture={() => setFocusedState(mainId)}>
            {renderSession(mainId, 'main')}
          </div>
          {showSplit && splitId ? (
            <>
              <Splitter
                orientation="vertical"
                label={t('wb_resizeSplit')}
                now={layout.split * 100}
                min={22}
                max={78}
                start={() => layout.split}
                onMove={(v, dx) => update((l) => ({ ...l, split: splitFromDrag(v, dx, editors.current?.clientWidth ?? 0, rtl) }))}
                onKey={(e) => {
                  const n = splitFromKey(layout.split, e.key, e.shiftKey, rtl)
                  if (n !== null) (e.preventDefault(), update((l) => ({ ...l, split: n })))
                }}
                onReset={() => update((l) => ({ ...l, split: 0.5 }))}
              />
              <div className={`wb-editor${focusId === splitId ? ' is-focus' : ''}`} onMouseDownCapture={() => setFocusedState(splitId)} onFocusCapture={() => setFocusedState(splitId)}>
                {renderSession(splitId, 'split')}
              </div>
            </>
          ) : null}
        </>
      ) : (
        page
      )}
      {dragTab && !narrow ? (
        <div className="wb-drop" aria-hidden="true">
          <div className="wb-drop-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => edDrop('here', e)}>
            {t('wb_dropHere')}
          </div>
          {canSplit(vp.w) ? (
            <div className="wb-drop-zone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => edDrop('beside', e)}>
              {t('wb_dropBeside')}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )

  return (
    <WorkbenchContext.Provider value={api}>
      <div className="wb" data-mode={narrow ? 'narrow' : 'wide'}>
        <div className="wb-body">
          <div className="wb-nav" style={navShown ? { width: fit.nav } : undefined} hidden={!narrow && !navShown} data-open={navOpen ? 'true' : undefined}>
            {nav({ openIds: tabs.open, onSplit: (id) => (inSession ? setTabs((s) => splitWith(s, id)) : activate(id)) })}
          </div>
          {navShown ? (
            <Splitter
              orientation="vertical"
              label={t('wb_resizeNav')}
              now={fit.nav}
              min={LIMITS.nav.min}
              max={LIMITS.nav.max}
              start={() => layout.nav.size}
              onMove={(v, dx) => update((l) => setPane(l, 'nav', { size: sizeFromDrag('nav', v, dx, rtl) }))}
              onKey={(e) => {
                const n = sizeFromKey('nav', layout.nav.size, e.key, e.shiftKey, rtl)
                if (n !== null) (e.preventDefault(), update((l) => setPane(l, 'nav', { size: n })))
              }}
              onReset={() => update((l) => resetPane(l, 'nav'))}
            />
          ) : null}

          <div className="wb-main">
            <div className="wb-col">
              <TabBar
                tabs={tabs}
                activeId={mainId}
                titleOf={(id) => sessions.find((s) => s.id === id)?.objective ?? info[id]?.title ?? id.slice(0, 8)}
                stateOf={(id) => sessions.find((s) => s.id === id)?.state ?? info[id]?.state ?? 'idle'}
                canSplit={canSplit(vp.w) && !narrow}
                navHidden={!narrow && !layout.nav.open}
                onToggleNav={() => update((l) => togglePane(l, 'nav'))}
                onActivate={activate}
                onClose={closeTab}
                onMove={(a, b) => setTabs((s) => moveTab(s, a, b))}
                onSplit={(id) => setTabs((s) => splitWith(s, id))}
                onUnsplit={() => setTabs(unsplit)}
                onSwap={() => setTabs(swapSplit)}
                onNew={() => onRoute({ page: 'home' })}
                onDragTab={setDragTab}
                homeActive={route.page === 'home'}
              />
              {editorBody}
              {dockShown ? (
                <>
                  {narrow ? <div className="scrim show" onClick={() => api.closeDock()} /> : null}
                  {!narrow ? (
                    <Splitter
                      orientation="horizontal"
                      label={t('wb_resizeDock')}
                      now={fit.dock}
                      min={LIMITS.dock.min}
                      max={LIMITS.dock.max}
                      start={() => layout.dock.size}
                      onMove={(v, _dx, dy) => update((l) => setPane(l, 'dock', { size: sizeFromDrag('dock', v, -dy, rtl) }))}
                      onKey={(e) => {
                        const n = sizeFromKey('dock', layout.dock.size, e.key, e.shiftKey, rtl)
                        if (n !== null) (e.preventDefault(), update((l) => setPane(l, 'dock', { size: n })))
                      }}
                      onReset={() => update((l) => resetPane(l, 'dock'))}
                    />
                  ) : null}
                  <div className="wb-dock" style={!narrow ? { height: fit.dock } : undefined} ref={setDockSlot} />
                </>
              ) : null}
            </div>

            {sideShown ? (
              <>
                {narrow ? <div className="scrim show" onClick={() => api.closeSide()} /> : null}
                {!narrow ? (
                  <Splitter
                    orientation="vertical"
                    label={t('wb_resizeSide')}
                    now={fit.side}
                    min={LIMITS.side.min}
                    max={LIMITS.side.max}
                    start={() => layout.side.size}
                    onMove={(v, dx) => update((l) => setPane(l, 'side', { size: sizeFromDrag('side', v, dx, rtl) }))}
                    onKey={(e) => {
                      const n = sizeFromKey('side', layout.side.size, e.key, e.shiftKey, rtl)
                      if (n !== null) (e.preventDefault(), update((l) => setPane(l, 'side', { size: n })))
                    }}
                    onReset={() => update((l) => resetPane(l, 'side'))}
                  />
                ) : null}
                <aside className="wb-side" style={!narrow ? { width: fit.side } : undefined} aria-label={t('details')} ref={setSideSlot} />
              </>
            ) : null}
          </div>
        </div>
        <StatusBar
          folder={folderName}
          info={focusId ? info[focusId] : undefined}
          inSession={inSession}
          preset={preset}
          onPreset={(p) => (setDrawer({ side: false, dock: false }), update((l) => applyPreset(l, p)))}
          onReset={() => update(() => DEFAULT_LAYOUT)}
          onAgents={() => api.openSide('agents')}
          onDock={() => api.openDock(layout.dockTab, true)}
          onSide={() => api.openSide(layout.sideTab, true)}
          sideOpen={sideOpen}
          dockOpen={dockOpen}
          narrow={narrow}
        />
      </div>
    </WorkbenchContext.Provider>
  )
}
