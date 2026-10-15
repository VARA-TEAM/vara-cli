import type { EngineEvent, Session } from './types.js'
import type { Provider } from '../llm/provider.js'
import type { VaraConfig } from '../config/config.js'
import { budgetFor } from '../config/config.js'
import { contextSettingsFor, thinkingFor, visionFor } from '../config/providers.js'
import { SessionRunner } from './runner.js'
import { discoverSkills } from './skills.js'
import { policyFor } from './modes.js'
import type { McpHub } from '../mcp/hub.js'

/**
 * The ONE place that wires a session to everything it needs: provider, live
 * context settings, skills, budgets, cheap-model routing, thinking level and
 * MCP tools. The TUI and the shared host both use it, so a feature added here
 * reaches every front end. Config/provider/hub are read through getters so a
 * model switch or an MCP change is seen on the next turn without rebuilding.
 */
export function makeSessionRunner(opts: {
  session: Session
  provider: () => Provider
  config: () => VaraConfig
  hub: McpHub
  onEvent: (event: EngineEvent) => void
}): SessionRunner {
  const { session: s, config, hub } = opts
  const model = () => s.config.model ?? config().provider.model
  return new SessionRunner(
    s,
    opts.provider(),
    model(),
    opts.onEvent,
    () => contextSettingsFor(config(), model()),
    {
      loadSkills: () => discoverSkills(s.config.cwd, config().skills.disabled),
      budgetFor: (k) => budgetFor(k, config()),
      routeModel: () => config().agent.cheapModel || undefined,
      thinkingLevel: (m) => thinkingFor(config(), m).level,
      modePolicy: () => policyFor(config().modes, s.config.customMode),
      vision: (m) => visionFor(config(), m),
      extraTools: () => hub.tools(),
      mcpSummary: () => hub.summary(),
    },
  )
}
