import React from 'react'
import { Box, Text } from 'ink'
import { glyph, theme, wrappedRows } from './theme.js'

const MAX_INPUT_ROWS = 6

/**
 * Bordered input box shared by the welcome screen and the session view.
 * Shows a block cursor, keeps multi-line drafts (paste / Alt+Enter) readable
 * by showing only the tail, and exposes mode/kind chips on the bottom line.
 */
export function PromptBox({
  value,
  placeholder,
  label,
  accent = theme.brand,
  width,
  footer,
}: {
  value: string
  placeholder: string
  /** Text before the input, e.g. `❯ ` or the new-session label. */
  label: string
  accent?: string
  width?: number
  footer?: React.ReactNode
}): React.ReactElement {
  // Show the tail of a long draft so the cursor line is always visible.
  const inner = Math.max(10, (width ?? 80) - 6 - label.length)
  const lines = value.split('\n')
  let shown = value
  let hidden = 0
  if (value && wrappedRows(value, inner) > MAX_INPUT_ROWS) {
    let rows = 0
    const keep: string[] = []
    for (let i = lines.length - 1; i >= 0; i--) {
      const r = wrappedRows(lines[i] ?? '', inner)
      if (rows + r > MAX_INPUT_ROWS && keep.length > 0) break
      keep.unshift(lines[i] ?? '')
      rows += r
    }
    hidden = lines.length - keep.length
    shown = keep.join('\n')
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} width={width} flexShrink={0}>
      <Box>
        <Text color={accent} bold>
          {label}
        </Text>
        <Box flexGrow={1}>
          {value ? (
            <Text>
              {hidden > 0 ? <Text dimColor>… </Text> : null}
              {shown}
              <Text inverse> </Text>
            </Text>
          ) : (
            <Text>
              <Text inverse> </Text>
              <Text dimColor>{placeholder}</Text>
            </Text>
          )}
        </Box>
      </Box>
      {footer ? <Box>{footer}</Box> : null}
    </Box>
  )
}

/** Small colored label chip, e.g. ` PLAN `. */
export function Chip({ text, color }: { text: string; color: string }): React.ReactElement {
  return (
    <Text backgroundColor={color} color={theme.onAccent} bold>
      {` ${text} `}
    </Text>
  )
}

export { glyph }
