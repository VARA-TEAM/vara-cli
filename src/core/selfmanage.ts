import type { VaraConfig } from '../config/config.js'
import type { Session } from './types.js'
import { resolveModeChoice } from './modes.js'
import { discoverAllSkills, validSkillName, writeSkill } from './skills.js'
import { serverFromInput } from '../mcp/input.js'

/**
 * What the agent may ask to change about ITSELF. Every method is only ever
 * called after the user approved the exact request (see tools/self-tools.ts);
 * the port itself never decides whether to ask.
 */
export interface AdminPort {
  writeSkill(name: string, description: string, body: string, scope: 'user' | 'project'): Promise<string>
  /** Turn a skill on/off for this session (`session`) or everywhere (`global`). */
  setSkillEnabled(name: string, enabled: boolean, scope: 'session' | 'global'): Promise<string>
  /** `scope` only matters for enable/disable: this session, or the saved config for everyone. */
  mcp(action: 'add' | 'remove' | 'enable' | 'disable', name: string, input?: string, scope?: 'session' | 'global'): Promise<string>
  setMode(name: string): Promise<string>
}

const MCP_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/

/**
 * The one implementation, shared by the terminal and the browser host. The
 * front end only supplies how a new config is applied and saved.
 */
export function makeAdminPort(deps: { session: Session; config: () => VaraConfig; apply: (next: VaraConfig) => Promise<void> }): AdminPort {
  const { session, config, apply } = deps
  return {
    async writeSkill(name, description, body, scope) {
      const r = await writeSkill(name, scope, session.config.cwd, description, body)
      return `${r.created ? 'Created' : 'Updated'} skill "${name}" (${scope}) at ${r.path}`
    },
    async setSkillEnabled(name, enabled, scope) {
      const known = await discoverAllSkills(session.config.cwd, [])
      if (!validSkillName(name) || !known.some((s) => s.name === name)) throw new Error(`No skill named "${name}".`)
      if (scope === 'session') {
        const off = new Set(session.config.disabledSkills ?? [])
        if (enabled) off.delete(name)
        else off.add(name)
        session.config.disabledSkills = [...off]
        return `Skill "${name}" is now ${enabled ? 'on' : 'off'} for this session.`
      }
      const c = config()
      const off = new Set(c.skills.disabled)
      if (enabled) off.delete(name)
      else off.add(name)
      await apply({ ...c, skills: { ...c.skills, disabled: [...off] } })
      return `Skill "${name}" is now ${enabled ? 'on' : 'off'} everywhere.`
    },
    async mcp(action, name, input, scope = 'global') {
      if (!MCP_NAME.test(name)) throw new Error('MCP server name: letters, digits, "-" or "_" (max 31).')
      const c = config()
      if (scope === 'session' && (action === 'enable' || action === 'disable')) {
        if (!c.mcp.servers[name]) throw new Error(`No MCP server named "${name}".`)
        const off = new Set(session.config.disabledMcp ?? [])
        if (action === 'enable') off.delete(name)
        else off.add(name)
        session.config.disabledMcp = [...off]
        return `MCP server "${name}" is now ${action === 'enable' ? 'on' : 'off'} for this session.`
      }
      const servers = { ...c.mcp.servers }
      if (action === 'add') {
        if (servers[name]) throw new Error(`MCP server "${name}" already exists.`)
        const parsed = serverFromInput(input ?? '')
        if (typeof parsed === 'string') throw new Error(parsed)
        servers[name] = { args: [], env: {}, secretEnv: [], headers: {}, ...parsed, enabled: true } as never
      } else {
        const cur = servers[name]
        if (!cur) throw new Error(`No MCP server named "${name}".`)
        if (action === 'remove') delete servers[name]
        else servers[name] = { ...cur, enabled: action === 'enable' }
      }
      await apply({ ...c, mcp: { ...c.mcp, servers } })
      return `MCP server "${name}": ${action} done.`
    },
    async setMode(name) {
      const choice = resolveModeChoice(config().modes, name)
      if (!choice.ok) throw new Error(choice.error)
      session.config.mode = choice.mode
      if (choice.customMode) session.config.customMode = choice.customMode
      else delete session.config.customMode
      return `Mode is now "${name}" (applies from the next turn).`
    },
  }
}
