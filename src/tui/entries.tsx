import React from 'react'
import { Box, Text } from 'ink'
import type { SessionState } from '../core/types.js'
import { outputPreview, summarizeArgs } from './format.js'
import { glyph, theme, wrappedRows } from './theme.js'
import { Markdown } from './markdown.js'

export type Entry =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; id: string; name: string; args: string; ok?: boolean; output?: string }
  /**
   * Notes are ephemeral status lines. `group` marks interchangeable notes
   * (e.g. all mode-switch notes): a new note with the same group REPLACES
   * the previous one instead of stacking — the transcript must not flood.
   */
  | { kind: 'note'; text: string; color: string; group?: string }
  | {
      kind: 'summary'
      /** The session state at report time — the heading must match it. */
      state: SessionState
      text: string
      requirements: Array<{ id: string; text: string; verified: boolean }>
      evidence: string[]
      stats: string
    }

export function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}

export function firstLine(text: string): string {
  return text.split('\n')[0] ?? ''
}

/**
 * Rows an entry occupies at `width` columns. Deliberately generous: the
 * viewport uses it to decide how many entries fit, and over-estimating only
 * means one more Page Up to reveal an entry — under-estimating makes the
 * frame taller than the terminal, which corrupts the display.
 */
export function entryRows(entry: Entry, width: number): number {
  switch (entry.kind) {
    case 'user':
      return wrappedRows(entry.text, width - 4) + 1
    case 'assistant':
      return wrappedRows(entry.text, width - 4) + 1
    case 'tool':
      if (entry.ok === false) {
        const out = entry.output ? Math.min(9, outputPreview(entry.output, 8).split('\n').length) : 0
        return 3 + out
      }
      return 1
    case 'note':
      return wrappedRows(entry.text, width - 4)
    case 'summary': {
      const reqs = entry.requirements.length
      const ev = entry.evidence.length ? entry.evidence.length + 2 : 0
      return 6 + wrappedRows(entry.text, width - 6) + reqs + ev + 1
    }
  }
}

function noteColor(color: string): string {
  const map: Record<string, string> = { gray: theme.muted, yellow: theme.warn, red: theme.err, green: theme.ok, cyan: theme.accent, magenta: theme.user, blue: theme.info }
  return map[color] ?? color
}

export function EntryView({ entry, compact = false }: { entry: Entry; compact?: boolean }): React.ReactElement | null {
  if (entry.kind === 'user') {
    // A left accent bar (not a full box) marks what the user said — light on
    // screen space, scannable at a glance.
    return (
      <Box marginTop={1} borderStyle="single" borderColor={theme.user} borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
        <Text>{entry.text}</Text>
      </Box>
    )
  }
  if (entry.kind === 'assistant') {
    return (
      <Box marginTop={1}>
        <Box width={2} flexShrink={0}>
          <Text color={theme.assistant}>{glyph.dot}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Markdown text={entry.text} />
        </Box>
      </Box>
    )
  }
  if (entry.kind === 'tool') {
    const pending = entry.ok === undefined
    const detail = !pending && entry.ok && entry.output ? firstLine(entry.output) : summarizeArgs(entry.args)
    if (entry.ok !== false) {
      return (
        <Box paddingLeft={2}>
          <Text wrap="truncate-end">
            <Text color={pending ? theme.muted : theme.ok}>{pending ? glyph.pending : glyph.ok} </Text>
            <Text bold>{entry.name}</Text>
            {compact ? null : <Text dimColor> {glyph.sep} {truncate(detail, 100)}</Text>}
          </Text>
        </Box>
      )
    }
    // Failures expand so problems cannot scroll past unnoticed.
    return (
      <Box marginLeft={2} flexDirection="column" borderStyle="single" borderColor={theme.err} borderTop={false} borderBottom={false} borderRight={false} paddingLeft={1}>
        <Text wrap="truncate-end">
          <Text color={theme.err} bold>
            {glyph.fail} {entry.name}
          </Text>
          <Text dimColor> {truncate(summarizeArgs(entry.args), 110)}</Text>
        </Text>
        {entry.output ? <Text color={theme.err}>{outputPreview(entry.output, 8)}</Text> : null}
      </Box>
    )
  }
  if (entry.kind === 'summary') {
    // The heading must never contradict the actual session state.
    const completed = entry.state === 'completed'
    const color = completed ? theme.ok : theme.warn
    const title = completed ? 'SESSION COMPLETE' : `SESSION REPORT — ${entry.state.replace('_', ' ').toUpperCase()}`
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1} marginY={1}>
        <Text bold color={color}>
          {completed ? glyph.ok : glyph.warn} {title}
        </Text>
        <Box marginTop={1}>
          <Text>{entry.text}</Text>
        </Box>
        <Box flexDirection="column" marginTop={1}>
          {entry.requirements.map((r) => (
            <Text key={r.id} wrap="truncate-end">
              <Text color={r.verified ? theme.ok : theme.err} bold>
                {r.verified ? glyph.ok : glyph.fail}{' '}
              </Text>
              <Text dimColor>{r.id}.</Text> {truncate(r.text, 120)}
            </Text>
          ))}
        </Box>
        {entry.evidence.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text bold dimColor>
              Evidence recorded by the engine
            </Text>
            {entry.evidence.map((line, i) => (
              <Text key={i} dimColor wrap="truncate-end">
                {'  '}
                {truncate(line, 120)}
              </Text>
            ))}
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Text dimColor>{entry.stats}</Text>
        </Box>
      </Box>
    )
  }
  return (
    <Box paddingLeft={2}>
      <Text color={noteColor(entry.color)}>
        <Text dimColor>{glyph.sep} </Text>
        {entry.text}
      </Text>
    </Box>
  )
}
