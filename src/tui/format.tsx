import React from 'react'
import { Box, Text } from 'ink'
import type { SessionState } from '../core/types.js'

const STATE_COLORS: Record<SessionState, string> = {
  idle: 'gray',
  running: 'green',
  waiting_user: 'yellow',
  paused: 'yellow',
  interrupted: 'red',
  completed: 'green',
  failed: 'red',
  stopped: 'gray',
}

export function StateBadge({ state }: { state: SessionState }): React.ReactElement {
  return (
    <Text backgroundColor={STATE_COLORS[state]} color="black" bold>
      {' '}
      {state.toUpperCase()}{' '}
    </Text>
  )
}

export function ToolLine({
  name,
  args,
  ok,
  output,
  expanded,
}: {
  name: string
  args: string
  ok?: boolean
  output?: string
  expanded?: boolean
}): React.ReactElement {
  const symbol = ok === undefined ? '⋯' : ok ? '✓' : '✗'
  const color = ok === undefined ? 'gray' : ok ? 'green' : 'red'
  const preview = summarizeArgs(args)
  return (
    <Box flexDirection="column" marginLeft={2}>
      <Text color={color}>
        {symbol} <Text bold>{name}</Text> <Text dimColor>{preview}</Text>
      </Text>
      {expanded && output ? <Text dimColor>{output}</Text> : null}
    </Box>
  )
}

export function summarizeArgs(args: string): string {
  try {
    const obj = JSON.parse(args) as Record<string, unknown>
    const parts: string[] = []
    for (const [k, v] of Object.entries(obj)) {
      if (v === undefined) continue
      const s = typeof v === 'string' ? v : JSON.stringify(v)
      parts.push(`${k}=${s.length > 60 ? s.slice(0, 57) + '…' : s}`)
    }
    return parts.join(' ')
  } catch {
    return args.slice(0, 120)
  }
}

export function outputPreview(output: string, maxLines = 6): string {
  const lines = output.split('\n')
  if (lines.length <= maxLines) return output
  return lines.slice(-maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)`
}

/**
 * Human-readable elapsed time. Raw seconds ("48861s") are unreadable — the
 * eye cannot tell 48861s from 4886s at a glance.
 *   45        → "45s"
 *   265       → "4m 25s"
 *   48861     → "13h 34m"
 */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0s'
  const s = Math.round(seconds)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}

/**
 * A compact usage bar for the sidebar, e.g. `▓▓▓▓░░░░░░  40%`.
 * Colors the fill red past 85% so pressure is visible without reading numbers.
 */
export function percentBar(percent: number, width = 10): React.ReactElement {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)))
  const filled = Math.round((clamped / 100) * width)
  const color = clamped > 85 ? 'red' : clamped > 70 ? 'yellow' : 'green'
  return (
    <Text>
      <Text color={color}>{'▓'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(Math.max(0, width - filled))}</Text>
      <Text dimColor> {String(clamped).padStart(3)}%</Text>
    </Text>
  )
}
