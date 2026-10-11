import React from 'react'
import { Box, Text } from 'ink'
import type { Mode, SessionKind } from '../core/types.js'

const LOGO = [
  ' ██╗   ██╗ █████╗ ██████╗  █████╗ ',
  ' ██║   ██║██╔══██╗██╔══██╗██╔══██╗',
  ' ██║   ██║███████║██████╔╝███████║',
  ' ╚██╗ ██╔╝██╔══██║██╔══██╗██╔══██║',
  '  ╚████╔╝ ██║  ██║██║  ██║██║  ██║',
  '   ╚═══╝  ╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝',
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
    <Box flexDirection="column" alignItems="center" marginTop={2} marginBottom={1}>
      <Text bold color="cyan">
        {LOGO.join('\n')}
      </Text>
      <Box marginTop={1}>
        <Text bold color="white">Autonomous Agent Execution Engine </Text>
        <Text dimColor>· Verified Completion</Text>
      </Box>
      <Box marginY={1} />
      <Box borderStyle="round" borderColor="cyan" paddingX={2} paddingY={0} flexDirection="column" width={74}>
        <Box>
          <Text color="cyan" bold>❯ </Text>
          <Text>
            {input || <Text dimColor>describe your objective… e.g. "fix failing tests and refactor core"</Text>}
          </Text>
        </Box>
        <Box marginTop={1} justifyContent="space-between">
          <Box>
            <Text backgroundColor={mode === 'plan' ? 'yellow' : 'green'} color="black" bold>
              {' '}{mode.toUpperCase()}{' '}
            </Text>
            <Text> </Text>
            <Text backgroundColor={kind === 'task' ? 'blue' : 'magenta'} color="black" bold>
              {' '}{kind.toUpperCase()}{' '}
            </Text>
          </Box>
          <Text dimColor>{model}</Text>
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text dimColor>
          {hasSessions ? '/sessions resumes saved work · ' : ''}Tab mode · Ctrl+G goal · Ctrl+K commands · Enter starts the session
        </Text>
      </Box>
    </Box>
  )
}
