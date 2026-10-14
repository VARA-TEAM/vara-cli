import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { COMMANDS } from './commands.js'
import { theme } from './theme.js'

/**
 * Ctrl+K command palette: type to filter, Up/Down to move, Enter to pick,
 * Esc to close. Commands that need arguments are inserted into the input
 * for the user to complete instead of running blind.
 */
export function CommandPalette({
  onPick,
  onClose,
}: {
  onPick: (insert: string) => void
  onClose: () => void
}): React.ReactElement {
  const [query, setQuery] = useState('')
  const [index, setIndex] = useState(0)

  const filtered = COMMANDS.filter((c) => {
    const hay = `${c.name} ${c.args ?? ''} ${c.description}`.toLowerCase()
    return query.toLowerCase().split(/\s+/).every((term) => hay.includes(term))
  })
  // Cap the list so the palette never overflows a normal terminal height.
  const MAX_SHOWN = 8
  const selected = Math.min(index, Math.max(0, filtered.length - 1))
  // Scroll the window with the selection — otherwise items past the 8th
  // could be selected but never seen.
  const first = Math.max(0, Math.min(selected - MAX_SHOWN + 1, filtered.length - MAX_SHOWN))
  const windowStart = selected >= MAX_SHOWN ? first : 0
  const shown = filtered.slice(windowStart, windowStart + MAX_SHOWN)

  useInput((raw, key) => {
    if (key.escape) {
      onClose()
      return
    }
    if (key.return) {
      const cmd = filtered[selected]
      if (!cmd) return
      const insert = cmd.args && cmd.needsArgs !== false ? `${cmd.name} ` : cmd.name
      onPick(insert)
      return
    }
    if (key.upArrow) {
      setIndex((i) => Math.max(0, i - 1))
      return
    }
    if (key.downArrow) {
      setIndex((i) => Math.min(filtered.length - 1, i + 1))
      return
    }
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
    <Box flexDirection="column" borderStyle="round" borderColor={theme.brand} paddingX={1} marginBottom={1}>
      <Text bold color={theme.brand}>
        Command palette
      </Text>
      <Box>
        <Text color={theme.brand}>▸ </Text>
        <Text>{query || <Text dimColor>type to filter…</Text>}</Text>
      </Box>
      <Box flexDirection="column" marginY={1}>
        {filtered.length === 0 ? (
          <Text dimColor>No command matches “{query}”.</Text>
        ) : (
          shown.map((c, i) => (
            <Text key={c.name} inverse={windowStart + i === selected} wrap="truncate-end">
              <Text>{windowStart + i === selected ? ' ▸ ' : '   '}</Text>
              <Text bold>{c.name}</Text>
              {c.args ? <Text dimColor> {c.args}</Text> : null}
              <Text dimColor> — {c.description}</Text>
              {c.hint ? <Text color={theme.warn}> [{c.hint}]</Text> : null}
            </Text>
          ))
        )}
        {filtered.length > MAX_SHOWN ? (
          <Text dimColor>
            {selected + 1}/{filtered.length} — keep typing to narrow
          </Text>
        ) : null}
      </Box>
      <Text dimColor>↑/↓ move · Enter pick · Esc close</Text>
    </Box>
  )
}
