import React from 'react'
import { Box, Text } from 'ink'
import type { Mode, SessionKind } from '../core/types.js'

const LOGO = [
  ' ██╗   ██╗ █████╗ ███████╗██╗  ██╗ █████╗ ███╗   ██╗',
  ' ██║   ██║██╔══██╗██╔════╝██║  ██║██╔══██╗████╗  ██║',
  ' ██║   ██║███████║███████╗███████║███████║██╔██╗ ██║',
  ' ╚██╗ ██╔╝██╔══██║╚════██║██╔══██║██╔══██║██║╚██╗██║',
  '  ╚████╔╝ ██║  ██║███████║██║  ██║██║  ██║██║ ╚████║',
  '   ╚═══╝  ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝',
]

/**
 * Startup screen: a clean landing state instead of a console questionnaire.
 * The prompt box below is the real input — the first message typed here
 * becomes the objective of a new session (kind/mode chosen with Ctrl+G / Tab,
 * shown live in the box, adjustable later with /kind and /mode).
 */
export function WelcomeScreen({
  kind,
  mode,
  model,
  hasSessions,
  input,
}: {
  kind: SessionKind
  mode: Mode
  model: string
  hasSessions: boolean
  input: string
}): React.ReactElement {
  return (
    <Box flexDirection="column" alignItems="center" marginTop={3}>
      <Text bold color="cyan">
        {LOGO.join('\n')}
      </Text>
      <Text dimColor>local agent execution engine — it works until the job is proven done</Text>
      <Box marginY={1} />
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column" width={70}>
        <Text>
          {input || <Text dimColor>describe the task… “fix the failing tests in src/core”</Text>}
        </Text>
        <Box marginTop={1}>
          <Text color={mode === 'plan' ? 'yellow' : 'green'} bold>
            {mode.toUpperCase()}
          </Text>
          <Text dimColor> · {kind.toUpperCase()} · {model}</Text>
        </Box>
      </Box>
      <Box marginY={1} />
      <Text dimColor>
        {hasSessions ? '/sessions resumes saved work · ' : ''}Tab mode · Ctrl+G goal · Ctrl+K commands · Enter starts the session
      </Text>
    </Box>
  )
}
