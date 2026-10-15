import React from 'react'
import { Box, Text } from 'ink'
import type { Session } from '../core/types.js'
import type { VaraConfig, SidebarSections } from '../config/config.js'
import type { ContextStatus } from '../core/context.js'
import { formatTokens } from '../core/context.js'
import { modeLabel } from '../core/modes.js'
import { formatUsd } from '../llm/cost.js'
import { activeProviderName } from '../config/providers.js'
import { percentBar } from './format.js'
import { truncate } from './entries.js'
import { glyph, theme } from './theme.js'

/** Total columns the sidebar occupies (App subtracts this from the transcript). */
export const SIDEBAR_WIDTH = 34

/** Unknown token counts must read as unknown — never as 0. */
function tok(value: number | null): string {
  return value === null ? '?' : formatTokens(value)
}

/** Files the agent wrote/edited/deleted, newest last, derived from the transcript. */
export function changedFiles(session: Session): Array<{ path: string; op: 'new' | 'edit' | 'del' }> {
  const seen = new Map<string, 'new' | 'edit' | 'del'>()
  for (const m of session.transcript) {
    for (const call of m.toolCalls ?? []) {
      if (call.name !== 'write_file' && call.name !== 'edit_file' && call.name !== 'delete_file' && call.name !== 'apply_patch') continue
      try {
        const path = (JSON.parse(call.arguments) as { path?: string }).path
        if (!path) continue
        const op = call.name === 'delete_file' ? 'del' : call.name === 'write_file' && !seen.has(path) ? 'new' : 'edit'
        seen.set(path, seen.get(path) === 'new' && op === 'edit' ? 'new' : op)
      } catch {
        /* unreadable arguments: skip */
      }
    }
  }
  return [...seen.entries()].map(([path, op]) => ({ path, op }))
}

function Section({ title, children }: { title: string; children: React.ReactNode }): React.ReactElement {
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text color={theme.muted} bold>
        {title.toUpperCase()}
      </Text>
      {children}
    </Box>
  )
}

/**
 * Right-hand status panel. Every section can be switched off in /settings
 * (ui.sections); the defaults answer the questions people actually have while
 * an agent works: which model, how full is the context, what is left to
 * prove, which files changed, what did it cost.
 */
export function Sidebar({
  session,
  config,
  ctx,
  usedTokens,
  sections,
  skillNames,
  think,
  mcpReady = 0,
}: {
  session: Session
  config: VaraConfig
  ctx: ContextStatus
  usedTokens: number
  sections: SidebarSections
  skillNames: string[]
  think?: string
  mcpReady?: number
}): React.ReactElement {
  const inner = SIDEBAR_WIDTH - 4
  const ctxPercent = Math.min(100, Math.round((usedTokens / Math.max(1, ctx.requestBudgetTokens)) * 100))
  const budget = session.config.budget
  const windowSource = { configured: 'manual', detected: 'detected', fallback: 'assumed' }[ctx.source]
  const costPartial = session.usage.costPartial || session.usage.unpricedCalls > 0
  const requirements = session.activeRequirements ?? []
  const verified = new Set(session.completionClaim?.verifiedRequirements ?? [])
  const files = changedFiles(session)
  const intent = session.intent ?? session.config.kind
  const intentColor = intent === 'chat' ? theme.chat : intent === 'question' ? theme.question : intent === 'goal' ? theme.goal : theme.task

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.border} paddingX={1} width={SIDEBAR_WIDTH} flexShrink={0} overflow="hidden">
      <Text bold color={theme.brand} wrap="truncate-end">
        {truncate(session.config.objective.replace(/\s+/g, ' '), inner)}
      </Text>
      <Text color={theme.muted} wrap="truncate-start">
        {session.config.cwd}
      </Text>

      {sections.session ? (
        <Section title="Session">
          <Text wrap="truncate-end">
            <Text color={intentColor} bold>
              {intent.toUpperCase()}
            </Text>
            <Text color={theme.muted}> {glyph.sep} </Text>
            <Text color={session.config.mode === 'plan' ? theme.plan : theme.build}>{modeLabel(session.config).toUpperCase()}</Text>
            <Text color={theme.muted}> {glyph.sep} turn {session.usage.turns}</Text>
          </Text>
          <Text color={theme.muted} wrap="truncate-end">
            {activeProviderName(config)} {glyph.sep} {session.config.model ?? config.provider.model}
          </Text>
          {think ? (
            <Text color={theme.muted} wrap="truncate-end">
              think: <Text color={think === 'off' ? theme.muted : theme.accent}>{think}</Text>
              {mcpReady ? ` ${glyph.sep} mcp: ${mcpReady} tools` : ''}
            </Text>
          ) : mcpReady ? (
            <Text color={theme.muted}>mcp: {mcpReady} tools</Text>
          ) : null}
        </Section>
      ) : null}

      {sections.context ? (
        <Section title="Context">
          <Text>
            {formatTokens(usedTokens)} / {formatTokens(ctx.requestBudgetTokens)} tok
          </Text>
          {percentBar(ctxPercent, inner - 6)}
          <Text color={theme.muted} wrap="truncate-end">
            window {formatTokens(ctx.windowTokens)} ({windowSource})
          </Text>
        </Section>
      ) : null}

      {sections.requirements && requirements.length ? (
        <Section title={`Requirements ${verified.size}/${requirements.length}`}>
          {requirements.slice(0, 5).map((r, i) => (
            <Text key={i} wrap="truncate-end">
              <Text color={verified.has(String(i + 1)) ? theme.ok : theme.muted}>{verified.has(String(i + 1)) ? glyph.ok : '○'} </Text>
              {truncate(r.replace(/^\[follow-up \w+\]\s*/, '').replace(/^The stated objective is achieved and verified:\s*/, ''), inner - 2)}
            </Text>
          ))}
          {requirements.length > 5 ? <Text color={theme.muted}>… {requirements.length - 5} more</Text> : null}
        </Section>
      ) : null}

      {sections.files && files.length ? (
        <Section title={`Files ${files.length}`}>
          {files.slice(-6).map((f) => (
            <Text key={f.path} wrap="truncate-start">
              <Text color={f.op === 'del' ? theme.err : f.op === 'new' ? theme.ok : theme.warn}>{f.op === 'del' ? '−' : f.op === 'new' ? '+' : '~'} </Text>
              {f.path}
            </Text>
          ))}
        </Section>
      ) : null}

      {sections.cost ? (
        <Section title="Cost">
          <Text color={costPartial ? theme.warn : undefined}>
            {session.usage.costUsd === null
              ? session.usage.unpricedCalls > 0
                ? `unknown (${session.usage.unpricedCalls} unpriced)`
                : 'unknown'
              : `${formatUsd(session.usage.costUsd)}${costPartial ? '+' : ''}`}
          </Text>
          <Text color={theme.muted} wrap="truncate-end">
            in {tok(session.usage.inputTokens)} {glyph.sep} out {tok(session.usage.outputTokens)}
            {session.usage.cachedInputTokens !== null ? ` ${glyph.sep} cached ${formatTokens(session.usage.cachedInputTokens)}` : ''}
          </Text>
          {session.savings && (session.savings.compactedChars || session.savings.dedupedReads || session.savings.cheapCalls || session.savings.subagents) ? (
            <Text color={theme.ok} wrap="truncate-end">
              saved: {formatTokens(Math.round(session.savings.compactedChars / 4))} tok{session.savings.dedupedReads ? ` ${glyph.sep} ${session.savings.dedupedReads} reads` : ''}
            </Text>
          ) : null}
        </Section>
      ) : null}

      {sections.budget ? (
        <Section title="Budget">
          <Text>
            turns {session.usage.turns}/{budget.maxTurns} {glyph.sep} calls {session.usage.modelCalls}/{budget.maxModelCalls}
          </Text>
          {percentBar(Math.max(session.usage.turns / Math.max(1, budget.maxTurns), session.usage.modelCalls / Math.max(1, budget.maxModelCalls)) * 100, inner - 6)}
          <Text color={theme.muted}>
            evidence {session.evidence.length} {glyph.sep} tools {session.usage.toolCalls}
          </Text>
        </Section>
      ) : null}

      {sections.skills && skillNames.length ? (
        <Section title={`Skills ${skillNames.length}`}>
          <Text color={theme.muted} wrap="truncate-end">
            {skillNames.join(', ')}
          </Text>
        </Section>
      ) : null}
    </Box>
  )
}
