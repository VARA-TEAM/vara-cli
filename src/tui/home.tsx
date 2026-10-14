import React from 'react'
import { Box, Text } from 'ink'
import type { Mode, SessionState } from '../core/types.js'
import { PromptBox, Chip } from './prompt.js'
import { glyph, stateColor, STATE_LABEL, theme } from './theme.js'

export type DraftKind = 'auto' | 'task' | 'goal'

export interface RecentSession {
  id: string
  objective: string
  state: SessionState
  updatedAt: string
}

/** Two-row block wordmark — compact, distinctive, no banner art. */
const WORDMARK = ['█ █ ▄▀█ █▀█ ▄▀█', '▀▄▀ █▀█ █▀▄ █▀█']

export function relativeTime(iso: string, now = Date.now()): string {
  const t = new Date(iso).getTime()
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d ago` : new Date(t).toLocaleDateString()
}

export const KIND_HELP: Record<DraftKind, string> = {
  auto: 'reads each message: chat, question, task or goal',
  task: 'bounded work — ends when verified',
  goal: 'ongoing — keeps going until you stop it',
}

/**
 * The start screen — shown at launch and for every new session (Ctrl+N).
 * Nothing is required: type anything (even "hi"), pick a recent session with
 * ↑/↓ + Enter, or open a command. The session is created on the first message.
 */
export function HomeScreen({
  input,
  kind,
  mode,
  providerName,
  model,
  cwd,
  recent,
  selected,
  columns,
  version,
  notice,
}: {
  input: string
  kind: DraftKind
  mode: Mode
  providerName: string
  model: string
  cwd: string
  recent: RecentSession[]
  /** Index into `recent`, or -1 when the prompt has focus. */
  selected: number
  columns: number
  version: string
  /** A warning to show above the prompt (e.g. no API key). */
  notice?: string
}): React.ReactElement {
  const width = Math.max(36, Math.min(86, columns - 4))
  const kindColor = kind === 'auto' ? theme.chat : kind === 'task' ? theme.task : theme.goal
  const placeholder =
    kind === 'goal' ? 'What should I keep doing? e.g. "keep the tests green"' : 'Ask anything, or describe the work…'
  return (
    <Box flexDirection="column" alignItems="center" flexGrow={1} justifyContent="center">
      <Box flexDirection="column" width={width}>
        <Box justifyContent="space-between" alignItems="flex-end">
          <Box flexDirection="column">
            <Text color={theme.brand} bold>
              {WORDMARK[0]}
            </Text>
            <Text color={theme.brand} bold>
              {WORDMARK[1]}
            </Text>
          </Box>
          <Text color={theme.muted}>v{version}</Text>
        </Box>
        <Box marginTop={1}>
          <Text color={theme.muted} wrap="truncate-start">
            {cwd}
          </Text>
        </Box>

        {notice ? (
          <Box marginTop={1}>
            <Text color={theme.warn}>
              {glyph.warn} {notice}
            </Text>
          </Box>
        ) : null}

        <Box marginTop={1}>
          <PromptBox
            value={input}
            label={`${glyph.prompt} `}
            placeholder={placeholder}
            width={width}
            accent={selected >= 0 ? theme.border : theme.brand}
            footer={
              <Box justifyContent="space-between" width={width - 4}>
                <Box>
                  <Chip text={kind.toUpperCase()} color={kindColor} />
                  <Text> </Text>
                  <Chip text={mode.toUpperCase()} color={mode === 'plan' ? theme.plan : theme.build} />
                </Box>
                <Text color={theme.muted} wrap="truncate-start">
                  {providerName} {glyph.sep} {model}
                </Text>
              </Box>
            }
          />
        </Box>
        <Text color={theme.muted}>
          {'  '}Enter send {glyph.sep} Tab plan/build {glyph.sep} Ctrl+G auto/task/goal {glyph.sep} Ctrl+K commands
        </Text>
        <Text color={theme.muted}>
          {'  '}
          {kind.toUpperCase()}: {KIND_HELP[kind]}
        </Text>

        {recent.length ? (
          <Box flexDirection="column" marginTop={1}>
            <Text color={theme.muted} bold>
              RECENT {glyph.sep} this folder <Text color={theme.muted}>(↓ to pick, Enter to open)</Text>
            </Text>
            {recent.map((r, i) => {
              const at = i === selected
              return (
                <Box key={r.id} justifyContent="space-between">
                  <Text wrap="truncate-end" color={at ? theme.brand : undefined} bold={at}>
                    {at ? `${glyph.prompt} ` : '  '}
                    {r.objective.replace(/\s+/g, ' ')}
                  </Text>
                  <Box flexShrink={0} marginLeft={2}>
                    <Text color={stateColor(r.state)}>{STATE_LABEL[r.state].padEnd(10)}</Text>
                    <Text color={theme.muted}>{relativeTime(r.updatedAt).padStart(9)}</Text>
                  </Box>
                </Box>
              )
            })}
          </Box>
        ) : null}

        <Box marginTop={1}>
          <Text color={theme.muted}>
            <Text color={theme.accent}>/providers</Text> models {glyph.sep} <Text color={theme.accent}>/settings</Text> theme & more{' '}
            {glyph.sep} <Text color={theme.accent}>/skills</Text> {glyph.sep} <Text color={theme.accent}>/help</Text>
          </Text>
        </Box>
      </Box>
    </Box>
  )
}
