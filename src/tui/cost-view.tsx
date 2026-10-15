import React from 'react'
import { Box, Text } from 'ink'
import type { LimitStatus } from '../core/usage-meter.js'
import { bar } from '../core/cost-report.js'

/**
 * Terminal cost views, self-contained (the web twins are ui/src/components/Cost*.tsx).
 * `CostMeterLine` is one line for the side panel or the status area: a bar, the
 * percentage and the pace — or nothing at all when no limit is set.
 */
export function CostMeterLine({ status, width = 14 }: { status: LimitStatus | null; width?: number }): React.ReactElement | null {
  if (!status || !status.configured) return null
  const color = status.level === 'critical' ? 'red' : status.level === 'high' || status.level === 'warn' ? 'yellow' : status.level === 'ok' ? 'green' : 'gray'
  const pace =
    status.hoursLeft === null
      ? ''
      : status.lastsUntilReset
        ? ' · lasts to reset'
        : ` · ~${status.hoursLeft < 1 ? `${Math.max(1, Math.round(status.hoursLeft * 60))}m` : `${status.hoursLeft.toFixed(1)}h`} left`
  return (
    <Box>
      <Text>limit </Text>
      <Text color={color}>{bar(status.percent, width)}</Text>
      <Text color={color}> {status.percent === null ? '?' : `${Math.round(status.percent)}%`}</Text>
      <Text dimColor>{pace}</Text>
    </Box>
  )
}
