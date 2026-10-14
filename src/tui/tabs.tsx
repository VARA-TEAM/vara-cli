import React from 'react'
import { Box, Text } from 'ink'
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
}: {
  tabs: TabInfo[]
  activeId: string
  /** The start screen is open as a "+ New" tab. */
  homeActive?: boolean
}): React.ReactElement {
  return (
    <Box marginBottom={0}>
      {tabs.map((tab) => {
        const active = !homeActive && tab.id === activeId
        const label = truncateLabel(tab.label, 28)
        return (
          <Text key={tab.id} inverse={active}>
            {' '}
            <Text color={stateColor(tab.state)} bold>
              ●
            </Text>{' '}
            <Text bold={active}>{label}</Text>{' '}
          </Text>
        )
      })}
      <Text inverse={homeActive} color={homeActive ? undefined : theme.muted}>{homeActive ? ' + New ' : ' + '}</Text>
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
