import React from 'react'
import { Box, Text } from 'ink'
import type { SessionState } from '../core/types.js'

export interface TabInfo {
  id: string
  label: string
  state: SessionState
}

const DOT_COLORS: Record<SessionState, string> = {
  idle: 'gray',
  running: 'green',
  waiting_user: 'yellow',
  paused: 'yellow',
  interrupted: 'red',
  completed: 'green',
  failed: 'red',
  stopped: 'gray',
}

function truncateLabel(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

/**
 * OpenCode-style session tabs: every open session is one tab, the active one
 * is highlighted, and its state is a colored dot. Switching is Alt+← / Alt+→;
 * the session objects live in memory, so switching is instant and loses
 * nothing — each tab keeps its own transcript view.
 */
export function TabBar({
  tabs,
  activeId,
}: {
  tabs: TabInfo[]
  activeId: string
}): React.ReactElement {
  return (
    <Box marginBottom={0}>
      {tabs.map((tab) => {
        const active = tab.id === activeId
        const label = truncateLabel(tab.label, 28)
        return (
          <Text key={tab.id} inverse={active}>
            {' '}
            <Text color={DOT_COLORS[tab.state]} bold>
              ●
            </Text>{' '}
            <Text bold={active}>{label}</Text>{' '}
          </Text>
        )
      })}
      <Text dimColor> + </Text>
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
