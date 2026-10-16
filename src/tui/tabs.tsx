import React, { useRef } from 'react'
import { Box, Text, type DOMElement } from 'ink'
import { useClickable } from './clicks.js'
import type { SessionState } from '../core/types.js'
import { stateColor, theme } from './theme.js'

export interface TabInfo {
  id: string
  label: string
  state: SessionState
}

function truncateLabel(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * Session tabs: every open session is one tab, the active one
 * is highlighted, and its state is a colored dot. Switching is Alt+← / Alt+→;
 * the session objects live in memory, so switching is instant and loses
 * nothing — each tab keeps its own transcript view.
 */
export function TabBar({
  tabs,
  activeId,
  homeActive = false,
  onSelect,
  onNew,
}: {
  tabs: TabInfo[]
  activeId: string
  /** The start screen is open as a "+ New" tab. */
  homeActive?: boolean
  /** A tab was clicked. */
  onSelect?: (id: string) => void
  /** The "+" was clicked. */
  onNew?: () => void
}): React.ReactElement {
  return (
    <Box marginBottom={0}>
      {tabs.map((tab) => (
        <Tab key={tab.id} tab={tab} active={!homeActive && tab.id === activeId} onClick={() => onSelect?.(tab.id)} />
      ))}
      <NewTab homeActive={homeActive} onClick={() => onNew?.()} />
    </Box>
  )
}

/** Tab switcher that avoids double-clicks on a selecting function. */
export function nextTabId(tabs: TabInfo[], activeId: string, delta: number): string {
  if (tabs.length === 0) return activeId
  const idx = tabs.findIndex((t) => t.id === activeId)
  const next = (idx + delta + tabs.length) % tabs.length
  return tabs[next]?.id ?? activeId
}

function Tab({ tab, active, onClick }: { tab: TabInfo; active: boolean; onClick: () => void }): React.ReactElement {
  const ref = useRef<DOMElement>(null)
  useClickable(ref, onClick)
  return (
    <Box ref={ref}>
      <Text inverse={active}>
        {' '}
        <Text color={stateColor(tab.state)} bold>
          ●
        </Text>{' '}
        <Text bold={active}>{truncateLabel(tab.label, 28)}</Text>{' '}
      </Text>
    </Box>
  )
}

function NewTab({ homeActive, onClick }: { homeActive: boolean; onClick: () => void }): React.ReactElement {
  const ref = useRef<DOMElement>(null)
  useClickable(ref, onClick)
  return (
    <Box ref={ref}>
      <Text inverse={homeActive} color={homeActive ? undefined : theme.muted}>
        {homeActive ? ' + New ' : ' + '}
      </Text>
    </Box>
  )
}
