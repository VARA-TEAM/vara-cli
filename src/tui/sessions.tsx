import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { listSessions } from '../core/store.js'
import { formatUsd } from '../llm/cost.js'

export interface SessionRow {
  id: string
  state: string
  kind: string
  mode?: string
  objective: string
  cwd: string
  updatedAt: string
  costUsd: number | null
  unpricedCalls: number
  currentId?: string
}

/**
 * /sessions overlay: search and switch sessions without leaving the TUI.
 * Scoped to the current directory by default; "all" toggles every directory.
 */
export function SessionBrowser({
  cwd,
  currentId,
  showAllInitially,
  onSwitch,
  onClose,
}: {
  cwd: string
  currentId: string
  showAllInitially?: boolean
  onSwitch: (id: string) => void
  onClose: () => void
}): React.ReactElement {
  const [rows, setRows] = useState<SessionRow[]>([])
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)
  const [showAll, setShowAll] = useState(showAllInitially ?? false)

  useEffect(() => {
    void listSessions().then((sessions) => {
      const here = normalize(cwd)
      setRows(
        sessions
          .filter((s) => showAll || normalize(s.cwd) === here)
          .map((s) => ({
            id: s.id,
            state: s.state,
            kind: s.kind,
            objective: s.objective,
            cwd: s.cwd,
            updatedAt: s.updatedAt,
            costUsd: s.costUsd,
            unpricedCalls: s.unpricedCalls,
          })),
      )
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAll])

  const filtered = rows.filter((r) => r.id.includes(query.toLowerCase()) || r.objective.toLowerCase().includes(query.toLowerCase()))
  // Cap the rendered rows to the terminal, and keep the selection INSIDE the
  // visible slice — before this, the highlight could sit on an off-screen row
  // while Enter opened a session the user never saw selected.
  const MAX_SHOWN = 12
  const shown = filtered.slice(0, MAX_SHOWN)
  const selected = Math.min(index, Math.max(0, shown.length - 1))

  useInput((raw, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.tab) {
      setShowAll((v) => !v)
      setIndex(0)
      return
    }
    if (key.return) {
      const row = shown[selected]
      if (row) onSwitch(row.id)
      return
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(shown.length - 1, i + 1))
      return
    }
    // Windows Terminal sends Backspace as \x7f — ink classifies it `delete`.
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setIndex(0)
      return
    }
    if (raw && !key.ctrl && !key.meta && raw >= ' ') {
      setQuery((q) => q + raw)
      setIndex(0)
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1}>
      <Text bold color="magenta">
        Sessions {showAll ? '(all directories)' : '(this directory)'} <Text dimColor>[Tab toggles scope]</Text>
      </Text>
      <Box>
        <Text color="magenta">▸ </Text>
        <Text>{query || <Text dimColor>type to filter by id or objective…</Text>}</Text>
      </Box>
      <Box flexDirection="column" marginY={1}>
        {filtered.length === 0 ? (
          <Text dimColor>No sessions match.</Text>
        ) : (
          shown.map((r, i) => (
            <Text key={r.id} inverse={i === selected}>
              <Text>{i === selected ? ' ▸ ' : '   '}</Text>
              <Text bold>{r.id}</Text>
              {r.id === currentId ? <Text color="cyan"> (current)</Text> : null}
              <Text dimColor> · </Text>
              <Text color={stateColor(r.state)}>{r.state}</Text>
              <Text dimColor> · {r.kind}</Text>
              <Text> {truncate(r.objective, 60)}</Text>
              <Text dimColor>
                {'  '}
                {r.cwd} · {new Date(r.updatedAt).toLocaleString()} · cost{' '}
                <Text color={r.costUsd === null || r.unpricedCalls > 0 ? 'yellow' : undefined}>
                  {r.costUsd === null ? 'unknown' : `${formatUsd(r.costUsd)}${r.unpricedCalls > 0 ? '+' : ''}`}
                </Text>
              </Text>
            </Text>
          ))
        )}
        {filtered.length > MAX_SHOWN ? <Text dimColor>… {filtered.length - MAX_SHOWN} more — keep typing to narrow</Text> : null}
      </Box>
      <Text dimColor>↑/↓ move · Enter open · Tab scope · Esc close</Text>
    </Box>
  )
}

function normalize(dir: string): string {
  const d = dir.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? d.toLowerCase() : d
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

function stateColor(state: string): string {
  if (state === 'completed') return 'green'
  if (state === 'failed') return 'red'
  if (state === 'running') return 'green'
  if (state === 'waiting_user') return 'yellow'
  return 'gray'
}
