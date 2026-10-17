import type { EngineEvent, Session } from './types.js'
import type { Provider } from '../llm/provider.js'
import type { VaraConfig } from '../config/config.js'
import { budgetFor } from '../config/config.js'
import { contextSettingsFor, thinkingFor, visionFor } from '../config/providers.js'
import { previewTool } from '../tools/preview-tool.js'
import { browserTool } from '../tools/browser-tool.js'
import { desktopTool } from '../tools/desktop-tool.js'
import { disabledFeatures } from '../server/features.js'
import type { Tool } from '../tools/types.js'
import { SessionRunner } from './runner.js'
import { discoverSkills } from './skills.js'
import { policyFor } from './modes.js'
import { makeAdminPort, type AdminPort } from './selfmanage.js'
import type { McpHub } from '../mcp/hub.js'
import { listSessions, loadSession } from './store.js'
import { namesOnly, type HostStatus } from './systeminfo.js'
import { keySource } from '../runtime.js'
import { listSecrets } from '../security/vault.js'
import { VERSION } from '../version.js'
import { costExtras } from './cost-wiring.js'
import { makeWebTools } from '../tools/web-tools.js'
import { makeMemoryTool } from '../tools/memory-tool.js'
import { skillProposeTool } from '../tools/proposal-tool.js'
import { memoryBlock } from './memory.js'

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
  /** Applies and saves a changed config (and makes it live). Without it the agent cannot manage itself. */
  applyConfig?: (next: VaraConfig) => Promise<void>
  /** A newer release, when the quiet check found one. */
  update?: () => { current: string; latest: string; url: string } | undefined
  /** What the running web host reports about itself (absent in the terminal). */
  host?: () => HostStatus | undefined
}): SessionRunner {
  const { session: s, config, hub } = opts
  const model = () => s.config.model ?? config().provider.model
  const memoryTool = makeMemoryTool(() => config().memory)
  const web = makeWebTools({ settings: () => config().agent.webSearch, browserEnabled: () => config().agent.browser })
  return new SessionRunner(
    s,
    opts.provider(),
    model(),
    opts.onEvent,
    () => contextSettingsFor(config(), model()),
    {
      loadSkills: () => discoverSkills(s.config.cwd, [...config().skills.disabled, ...(s.config.disabledSkills ?? [])]),
      budgetFor: (k) => budgetFor(k, config()),
      routeModel: () => config().agent.cheapModel || undefined,
      ...costExtras(config),
      thinkingLevel: (m) => thinkingFor(config(), m).level,
      modePolicy: () => policyFor(config().modes, s.config.customMode),
      swarm: () => config().swarm,
      vision: (m) => visionFor(config(), m),
      ...(opts.applyConfig ? { admin: makeAdminPort({
              session: s,
              config,
              apply: opts.applyConfig,
              system: {
                hub,
                version: VERSION,
                // NAMES only: the vault's own listing also carries a hint with the first characters, which is never passed on.
                secretNames: async () => namesOnly(await listSecrets()),
                keyState: (e) => keySource(e),
                listSessions,
                loadSession,
                ...(opts.update ? { update: opts.update } : {}),
                ...(opts.host ? { host: opts.host } : {}),
              },
            }) as AdminPort, interactive: true } : {}),
      extraTools: () => [...hub.tools(new Set(s.config.disabledMcp ?? [])), previewTool as unknown as Tool<never>, ...(config().agent.webSearch.enabled ? [web.search as unknown as Tool<never>] : []), ...(config().agent.webSearch.fetch ? [web.fetch as unknown as Tool<never>] : []), ...(config().agent.browser && !disabledFeatures().has('browser') ? [browserTool as unknown as Tool<never>] : []), ...(config().agent.desktop && opts.applyConfig && !disabledFeatures().has('desktop') ? [desktopTool as unknown as Tool<never>] : []), ...(config().memory.enabled ? [memoryTool as unknown as Tool<never>] : []), ...(config().skills.propose && opts.applyConfig ? [skillProposeTool as unknown as Tool<never>] : [])],
      memoryBlock: () => (config().memory.enabled ? memoryBlock(s.config.cwd, config().memory.maxTokens) : ''),
      mcpSummary: () => hub.summary(new Set(s.config.disabledMcp ?? [])),
    },
  )
}
