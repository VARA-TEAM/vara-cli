import { useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import { useT } from '../i18n'
import type { TabsState } from '../tabs'
import { Icon, Menu, MenuItem } from './ui'

const DOT: Record<string, string> = { running: 'run', waiting_user: 'ask', paused: 'ask', failed: 'bad', interrupted: 'bad', completed: 'ok' }

/**
 * Open sessions as tabs. Drag a tab to reorder it, or onto the conversation to open it beside the
 * current one (split view). From the keyboard: arrows move between tabs, Alt+Shift+arrows reorder,
 * Delete closes, and the "Split" menu lists the other open sessions.
 */
export function TabBar({
  tabs,
  activeId,
  homeActive,
  titleOf,
  stateOf,
  canSplit,
  navHidden,
  onToggleNav,
  onActivate,
  onClose,
  onMove,
  onSplit,
  onUnsplit,
  onSwap,
  onNew,
  onDragTab,
}: {
  tabs: TabsState
  activeId: string | null
  homeActive: boolean
  titleOf: (id: string) => string
  stateOf: (id: string) => string
  canSplit: boolean
  navHidden: boolean
  onToggleNav: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onMove: (from: string, to: string) => void
  onSplit: (id: string) => void
  onUnsplit: () => void
  onSwap: () => void
  onNew: () => void
  onDragTab: (id: string | null) => void
}) {
  const t = useT()
  const [over, setOver] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)
  const dragging = useRef<string | null>(null)

  const focusTab = (id: string): void => void list.current?.querySelector<HTMLElement>(`[data-tab="${CSS.escape(id)}"]`)?.focus()

  const onKey = (e: KeyboardEvent<HTMLDivElement>, id: string): void => {
    const i = tabs.open.indexOf(id)
    const rtl = document.documentElement.dir === 'rtl'
    const dir = e.key === 'ArrowRight' ? (rtl ? -1 : 1) : e.key === 'ArrowLeft' ? (rtl ? 1 : -1) : 0
    if (e.altKey && e.shiftKey && dir) {
      const to = tabs.open[i + dir]
      if (to) (e.preventDefault(), e.stopPropagation(), onMove(id, to), setTimeout(() => focusTab(id), 0))
    } else if (dir && !e.altKey) {
      const to = tabs.open[(i + dir + tabs.open.length) % tabs.open.length]
      if (to) (e.preventDefault(), focusTab(to))
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      const to = e.key === 'Home' ? tabs.open[0] : tabs.open[tabs.open.length - 1]
      if (to) focusTab(to)
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      onActivate(id)
    } else if (e.key === 'Delete') {
      e.preventDefault()
      onClose(id)
    }
  }

  const dragStart = (e: DragEvent, id: string): void => {
    dragging.current = id
    e.dataTransfer.setData('text/vara-tab', id)
    e.dataTransfer.effectAllowed = 'move'
    // Let the browser take its drag image first; the drop zones appear on the next frame.
    setTimeout(() => onDragTab(id), 0)
  }
  const dragEnd = (): void => {
    dragging.current = null
    setOver(null)
    onDragTab(null)
  }

  const others = tabs.open.filter((id) => id !== tabs.active)

  return (
    <div className="tabbar">
      {navHidden ? (
        <button className="icon-btn" onClick={onToggleNav} aria-label={t('wb_navToggle')} title={`${t('wb_navToggle')} (Ctrl B)`}>
          <Icon name="menu" />
        </button>
      ) : null}
      <div className="tabs" role="tablist" aria-label={t('wb_tabs')} ref={list}>
        {tabs.open.map((id) => {
          const active = id === activeId
          const beside = id === tabs.split
          const st = stateOf(id)
          return (
            <div
              key={id}
              role="tab"
              tabIndex={active || (!activeId && id === tabs.open[0]) ? 0 : -1}
              data-tab={id}
              aria-selected={active}
              className={`tab${active ? ' on' : ''}${beside ? ' beside' : ''}${over === id ? ' drop' : ''}`}
              draggable
              onClick={() => onActivate(id)}
              onAuxClick={(e) => e.button === 1 && onClose(id)}
              onKeyDown={(e) => onKey(e, id)}
              onDragStart={(e) => dragStart(e, id)}
              onDragEnd={dragEnd}
              onDragOver={(e) => {
                if (dragging.current && dragging.current !== id) (e.preventDefault(), setOver(id))
              }}
              onDragLeave={() => setOver((o) => (o === id ? null : o))}
              onDrop={(e) => {
                e.preventDefault()
                const from = dragging.current ?? e.dataTransfer.getData('text/vara-tab')
                setOver(null)
                if (from && from !== id) onMove(from, id)
              }}
              title={titleOf(id)}
            >
              <span className={`tab-dot tab-dot-${DOT[st] ?? 'idle'}`} aria-hidden="true" />
              <span className="tab-title" dir="auto">
                {titleOf(id)}
              </span>
              {beside ? <span className="tab-tag" title={t('wb_besideTag')}><Icon name="panel" size={12} /></span> : null}
              <button
                className="tab-x"
                tabIndex={-1}
                aria-label={`${t('wb_closeTab')}: ${titleOf(id)}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onClose(id)
                }}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          )
        })}
        <button className={`tab-new${homeActive ? ' on' : ''}`} onClick={onNew} aria-label={t('newSession')} title={`${t('newSession')} (Ctrl Shift O)`}>
          <Icon name="plus" size={16} />
        </button>
      </div>
      {canSplit && tabs.open.length > 1 ? (
        <Menu label={t('wb_split')} icon="panel">
          {(close) => (
            <>
              {tabs.split ? (
                <>
                  <MenuItem icon="down" onClick={() => (close(), onSwap())}>
                    {t('wb_swap')}
                  </MenuItem>
                  <MenuItem icon="x" onClick={() => (close(), onUnsplit())}>
                    {t('wb_unsplit')}
                  </MenuItem>
                </>
              ) : null}
              {others.map((id) => (
                <MenuItem key={id} icon="panel" onClick={() => (close(), onSplit(id))}>
                  <span className="clip">{t('wb_splitWith')}: {titleOf(id)}</span>
                </MenuItem>
              ))}
            </>
          )}
        </Menu>
      ) : null}
      {tabs.open.length === 0 ? (
        <span className="muted small tab-hint">{t('wb_noTabs')}</span>
      ) : null}
      <span className="sr-only" aria-live="polite">{activeId ? titleOf(activeId) : ''}</span>
    </div>
  )
}
