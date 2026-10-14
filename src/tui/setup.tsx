import React from 'react'
import { Box, Text, useApp } from 'ink'
import type { VaraConfig } from '../config/config.js'
import { persistConfig } from '../config/config.js'
import { ProviderManager, type ManagerDeps } from './providers.js'
import { theme } from './theme.js'

/**
 * `vara setup`: the provider manager as a standalone screen. Every edit is
 * saved immediately; picking a model makes it the active one and exits.
 */
export function SetupApp({
  config,
  deps,
  onResult,
}: {
  config: VaraConfig
  deps?: Partial<ManagerDeps>
  onResult: (config: VaraConfig, used: boolean) => void
}): React.ReactElement {
  const { exit } = useApp()
  const latest = React.useRef(config)
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.brand}>
          VARA setup
        </Text>
        <Text dimColor> · connect providers, fetch their models, pick one to use</Text>
      </Box>
      <ProviderManager
        config={config}
        deps={deps}
        maxRows={Math.max(4, Math.min(12, (process.stdout.rows ?? 30) - 14))}
        onChange={(c) => {
          latest.current = c
          void persistConfig(c)
        }}
        onUse={(c) => {
          void persistConfig(c).then(() => {
            onResult(c, true)
            exit()
          })
        }}
        onClose={() => {
          onResult(latest.current, false)
          exit()
        }}
      />
    </Box>
  )
}
