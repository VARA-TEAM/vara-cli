import React from 'react'
import { Box, Text } from 'ink'
import type { Session } from '../core/types.js'
import type { VaraConfig } from '../config/config.js'
import type { ContextStatus } from '../core/context.js'
import { formatTokens } from '../core/context.js'
import { formatUsd } from '../llm/cost.js'
import { percentBar } from './format.js'
import { truncate } from './entries.js'

/** Unknown token counts must read as unknown — never as 0. */
function tok(value: number | null): string {
  return value === null ? '?' : formatTokens(value)
}

/**
 * Right-hand status panel (OpenCode-style). Everything the header used to
 * cram into two lines, laid out where the eye can scan it: what this session
 * is, how much context it has used, what budget remains, what it cost, and
 * how much proof of work exists.
 *
 * Pure presentational — hidden automatically on narrow terminals by App.
 */
export function Sidebar({
  session,
  config,
  ctx,
  usedTokens,
}: {
  session: Session
  config: VaraConfig
  ctx: ContextStatus
  usedTokens: number
}): React.ReactElement {
  const ctxPercent = Math.min(100, Math.round((usedTokens / ctx.requestBudgetTokens) * 100))
  const budget = session.config.budget
  const windowSource = { configured: 'configured', detected: 'registry', fallback: 'fallback' }[ctx.source]
  const costPartial = session.usage.costPartial || session.usage.unpricedCalls > 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={34}>
      <Text bold color="cyan">
        {truncate(session.config.objective, 30)}
      </Text>
      <Text dimColor>{truncate(session.config.cwd, 30)}</Text>

      <Box marginY={1} flexDirection="column">
        <Text bold>Context</Text>
        <Text>
          {formatTokens(usedTokens)} / {formatTokens(ctx.requestBudgetTokens)} tok
        </Text>
        {percentBar(ctxPercent)}
        <Text dimColor>window ~{formatTokens(ctx.windowTokens)} ({windowSource})</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Budget</Text>
        <Text>
          turns {session.usage.turns}/{budget.maxTurns} · calls {session.usage.modelCalls}/{budget.maxModelCalls}
        </Text>
        {percentBar(Math.max(session.usage.turns / budget.maxTurns, session.usage.modelCalls / budget.maxModelCalls) * 100)}
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        <Text bold>Cost</Text>
        <Text color={costPartial ? 'yellow' : undefined}>
          {session.usage.costUsd === null
            ? session.usage.unpricedCalls > 0
              ? `unknown (${session.usage.unpricedCalls} unpriced)`
              : 'unknown'
            : `${formatUsd(session.usage.costUsd)}${costPartial ? '+' : ''}`}
        </Text>
        <Text dimColor>
          in {tok(session.usage.inputTokens)} · out {tok(session.usage.outputTokens)}
          {session.usage.cachedInputTokens !== null ? ` · cached ${formatTokens(session.usage.cachedInputTokens)}` : ''}
        </Text>
      </Box>

      <Box flexDirection="column">
        <Text bold>Proof</Text>
        <Text>
          evidence {session.evidence.length} · tools {session.usage.toolCalls}
        </Text>
        <Text dimColor>provider {config.provider.id}</Text>
        <Text dimColor>verify: {truncate(session.config.verifyCommand ?? '(none)', 26)}</Text>
      </Box>
    </Box>
  )
}
