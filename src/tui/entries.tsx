import React from 'react'
import { Box, Text } from 'ink'
import type { SessionState } from '../core/types.js'
import { outputPreview, summarizeArgs } from './format.js'

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

export function EntryView({ entry }: { entry: Entry }): React.ReactElement | null {
  if (entry.kind === 'user') {
    // User messages get a bordered block so they stand out from agent output
    // at a glance — the conversation reads as a dialogue, not a wall of text.
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box borderStyle="round" borderColor="magenta" paddingX={1}>
          <Text color="magenta" bold>
            you
          </Text>
          <Text>  {entry.text}</Text>
        </Box>
      </Box>
    )
  }
  if (entry.kind === 'assistant') {
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>{entry.text}</Text>
      </Box>
    )
  }
  if (entry.kind === 'tool') {
    // Successful tools collapse to one line; failures expand into a block so
    // problems cannot scroll past unnoticed. Full output stays on /last.
    // Replayed entries may lack output (trimmed by the engine) — summarize
    // the arguments readably instead of dumping raw JSON.
    if (entry.ok === true || entry.ok === undefined) {
      const detail = entry.output ? firstLine(entry.output) : summarizeArgs(entry.args)
      return (
        <Box marginBottom={0}>
          <Text dimColor>
            {entry.ok === true ? <Text color="green">✓ </Text> : <Text color="gray">⋯ </Text>}
            {entry.name} · {truncate(detail, 110)}
          </Text>
        </Box>
      )
    }
    return (
      <Box flexDirection="column" marginBottom={1}>
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1}>
          <Text>
            <Text color="red" bold>
              ✗ {entry.name}
            </Text>{' '}
            <Text dimColor>{truncate(summarizeArgs(entry.args), 140)}</Text>
          </Text>
          {entry.output ? <Text dimColor>{outputPreview(entry.output, 8)}</Text> : null}
        </Box>
      </Box>
    )
  }
  if (entry.kind === 'summary') {
    // The heading must never contradict the actual session state.
    const completed = entry.state === 'completed'
    const title = completed ? 'SESSION COMPLETE' : `SESSION REPORT — ${entry.state.replace('_', ' ').toUpperCase()}`
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={completed ? 'green' : 'yellow'} paddingX={1} marginY={1}>
        <Text bold color={completed ? 'green' : 'yellow'}>
          {title}
        </Text>
        <Text>{entry.text}</Text>
        <Box flexDirection="column" marginY={1}>
          {entry.requirements.map((r) => (
            <Text key={r.id}>
              <Text color={r.verified ? 'green' : 'red'}>{r.verified ? ' ✓ ' : ' ✗ '}</Text>
              <Text dimColor>{r.id}.</Text> {truncate(r.text, 120)}
            </Text>
          ))}
        </Box>
        {entry.evidence.length ? (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold dimColor>
              Evidence recorded by the engine:
            </Text>
            {entry.evidence.map((line, i) => (
              <Text key={i} dimColor>
                {'  '}
                {truncate(line, 120)}
              </Text>
            ))}
          </Box>
        ) : null}
        <Text dimColor>{entry.stats}</Text>
      </Box>
    )
  }
  return (
    <Box marginBottom={1}>
      <Text color={entry.color}>{entry.text}</Text>
    </Box>
  )
}
