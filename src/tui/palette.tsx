import React, { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { COMMANDS } from './commands.js'

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
  const shown = filtered.slice(0, MAX_SHOWN)
  const selected = Math.min(index, Math.max(0, shown.length - 1))

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
      setIndex((i) => Math.min(shown.length - 1, i + 1))
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
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginBottom={1}>
      <Text bold color="cyan">
        Command palette
      </Text>
      <Box>
        <Text color="cyan">▸ </Text>
        <Text>{query || <Text dimColor>type to filter…</Text>}</Text>
      </Box>
      <Box flexDirection="column" marginY={1}>
        {filtered.length === 0 ? (
          <Text dimColor>No command matches “{query}”.</Text>
        ) : (
          shown.map((c, i) => (
            <Text key={c.name} inverse={i === selected}>
              <Text>{i === selected ? ' ▸ ' : '   '}</Text>
              <Text bold>{c.name}</Text>
              {c.args ? <Text dimColor> {c.args}</Text> : null}
              <Text dimColor> — {c.description}</Text>
              {c.hint ? <Text color="yellow"> [{c.hint}]</Text> : null}
            </Text>
          ))
        )}
        {filtered.length > MAX_SHOWN ? <Text dimColor>… {filtered.length - MAX_SHOWN} more — keep typing to narrow</Text> : null}
      </Box>
      <Text dimColor>↑/↓ move · Enter pick · Esc close</Text>
    </Box>
  )
}
