import React, { useEffect, useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { activeCount, agentLine, costText, isBusy, swarmCost, type AgentRow, type SwarmView } from './agents.js'
import { glyph, theme } from './theme.js'
import { truncate } from './entries.js'

const STATUS_COLOR = (s: AgentRow['status']): string => (s === 'done' ? theme.ok : s === 'failed' ? theme.err : s === 'running' ? theme.accent : theme.muted)

/**
 * /agents: the sub-agents of this session, live. ↑/↓ pick one, Enter shows what it reported, c cancels it,
 * C cancels them all, m shows the merged report the main agent received, ←/→ move between swarms.
 */
export function AgentsScreen({
  swarms,
  maxRows,
  onCancel,
  onClose,
}: {
  swarms: SwarmView[]
  maxRows: number
  /** One agent's id, or no id for the whole swarm. Returns whether anything was running. */
  onCancel: (id?: string) => boolean
  onClose: () => void
}): React.ReactElement {
  const [which, setWhich] = useState(Math.max(0, swarms.length - 1))
  const [index, setIndex] = useState(0)
  const [mode, setMode] = useState<'list' | 'detail' | 'merged'>('list')
  const [now, setNow] = useState(Date.now())
  const [note, setNote] = useState('')

  const view = swarms[Math.min(which, swarms.length - 1)]
  const busy = isBusy(view)
  useEffect(() => {
    if (!busy) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [busy])

  const rows = view?.rows ?? []
  const sel = Math.min(index, Math.max(0, rows.length - 1))
  const row = rows[sel]

  useInput((raw, key) => {
    if (key.escape) {
      if (mode !== 'list') setMode('list')
      else onClose()
      return
    }
    if (key.upArrow) return void setIndex((i) => Math.max(0, i - 1))
    if (key.downArrow) return void setIndex((i) => Math.min(rows.length - 1, i + 1))
    if (key.leftArrow) return void (setWhich((w) => Math.max(0, w - 1)), setIndex(0), setMode('list'))
    if (key.rightArrow) return void (setWhich((w) => Math.min(swarms.length - 1, w + 1)), setIndex(0), setMode('list'))
    if (key.return) return void setMode((m) => (m === 'detail' ? 'list' : 'detail'))
    if (raw === 'm') return void setMode((m) => (m === 'merged' ? 'list' : 'merged'))
    if (raw === 'c' && row) {
      const ok = row.status === 'running' ? onCancel(row.id) : false
      setNote(ok ? `cancelling ${row.id}…` : row.status === 'waiting' ? 'it is waiting: cancel the whole swarm with C' : 'that agent is not running')
      return
    }
    if (raw === 'C') {
      setNote(onCancel() ? 'cancelling every agent…' : 'nothing is running')
    }
  })

  if (!view) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
        <Text bold color={theme.accent}>Agents</Text>
        <Text color={theme.muted}>No sub-agents have run in this session yet.</Text>
        <Text color={theme.muted}>The agent starts them with the delegate tool when work splits into independent pieces (research in several places, separate files, implement + test). Esc closes.</Text>
      </Box>
    )
  }

  const c = activeCount(view)
  const cost = costText(swarmCost(view))
  const body = Math.max(3, maxRows - 4)
  const detailLines = (mode === 'merged' ? (view.report?.merged ?? 'The merged report appears when the swarm ends.') : (row?.report ?? (row?.status === 'running' ? '(still working — no report yet)' : '(no report)'))).split('\n')

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1} marginBottom={1}>
      <Text bold color={theme.accent} wrap="truncate-end">
        Agents #{view.swarm} <Text color={theme.muted}>({which + 1}/{swarms.length}) {glyph.sep} {busy ? 'working' : 'finished'} {glyph.sep} {c.done} done{c.failed ? `, ${c.failed} failed` : ''}{c.skipped ? `, ${c.skipped} skipped` : ''}{c.running ? `, ${c.running} running` : ''}{c.waiting ? `, ${c.waiting} waiting` : ''} {glyph.sep} {cost}</Text>
      </Text>
      {mode === 'list' ? (
        <Box flexDirection="column" marginTop={1}>
          {rows.slice(Math.max(0, Math.min(sel - Math.floor(body / 2), rows.length - body)), Math.max(0, Math.min(sel - Math.floor(body / 2), rows.length - body)) + body).map((r) => (
            <Text key={r.id} inverse={r.id === row?.id} color={STATUS_COLOR(r.status)} wrap="truncate-end">
              {r.id === row?.id ? '▸ ' : '  '}
              {agentLine(r, now)}
            </Text>
          ))}
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text bold wrap="truncate-end">
            {mode === 'merged' ? 'Merged report (what the main agent received)' : `${row?.title ?? ''}${row?.role ? ` [${row.role}]` : ''} ${glyph.sep} ${row?.id}`}
          </Text>
          {detailLines.slice(0, body).map((l, i) => (
            <Text key={i} wrap="truncate-end">{truncate(l, 200)}</Text>
          ))}
          {detailLines.length > body ? <Text color={theme.muted}>… {detailLines.length - body} more lines (the full text is in the main conversation's delegate result)</Text> : null}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.muted} wrap="truncate-end">
          {note || '↑/↓ pick · Enter report · c cancel it · C cancel all · m merged report · ←/→ swarm · Esc close'}
        </Text>
      </Box>
    </Box>
  )
}

/** Side-panel section: the latest swarm, compact. */
export function AgentsSection({ view, width, now }: { view: SwarmView; width: number; now: number }): React.ReactElement {
  const c = activeCount(view)
  const busy = c.running + c.waiting > 0
  return (
    <Box flexDirection="column" marginTop={1} flexShrink={0}>
      <Text color={theme.muted} bold wrap="truncate-end">
        {`AGENTS #${view.swarm} ${busy ? '· working' : '· finished'}`}
      </Text>
      {view.rows.slice(0, 4).map((r) => (
        <Text key={r.id} color={STATUS_COLOR(r.status)} wrap="truncate-end">
          {agentLine(r, now, { width, dependencies: false })}
        </Text>
      ))}
      {view.rows.length > 4 ? <Text color={theme.muted}>… {view.rows.length - 4} more</Text> : null}
      <Text color={theme.muted} wrap="truncate-end">
        {costText(swarmCost(view))} {glyph.sep} /agents
      </Text>
    </Box>
  )
}
