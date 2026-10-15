import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import type { McpServerConfig } from '../mcp/client.js'
import { MCP_PRESETS, type McpHub } from '../mcp/hub.js'
import { serverFromInput } from '../mcp/input.js'
import { CONNECTORS, connectorServer, findConnector, type Connector } from '../mcp/connectors.js'
import { beginLogin, oauthLogout, oauthStatus, type LoginHandle } from '../mcp/oauth.js'
import type { VaraConfig, ProviderEntry } from '../config/config.js'
import {
  activate,
  activeProviderName,
  addCustomProvider,
  addModel,
  addProviderFromPreset,
  contextOrigin,
  defaultModelFor,
  mergeDiscovered,
  removeModel,
  removeProvider,
  secretNameFor,
  setModelContext,
  setModelStatus,
  setModelThinking,
  thinkingFor,
  validProviderName,
} from '../config/providers.js'
import { PRESETS, findPreset } from '../llm/presets.js'
import type { CheckResult, Endpoint } from '../llm/discovery.js'
import type { FoundModel } from '../config/providers.js'
import { discoverAllSkills, scaffoldSkill, validSkillName } from '../core/skills.js'
import { validModeName, type ModeDef } from '../core/modes.js'
import { THINK_ORDER, type ThinkLevel } from '../llm/capabilities.js'
import { scrubAll } from '../security/redact.js'
import { applyCostPatch, costBoard } from './cost-api.js'
import { sharedMeter } from '../core/usage-meter.js'

export type MResult<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409 | 502; error: string }
const bad = (error: string, status: 400 | 404 | 409 | 502 = 400): { ok: false; status: 400 | 404 | 409 | 502; error: string } => ({ ok: false, status, error })
const good = <T>(value: T): { ok: true; value: T } => ({ ok: true, value })

/** Everything the manager touches outside itself, injectable so tests never hit a network or a vault. */
export interface ManagerDeps {
  config(): VaraConfig
  /** Persist the new config and make it live (rebuild the provider, sync MCP). Throws a readable error to refuse it. */
  apply(next: VaraConfig): Promise<void>
  hub: McpHub
  cwd: string
  discover(ep: Endpoint): Promise<FoundModel[]>
  check(ep: Endpoint, model: string): Promise<CheckResult>
  endpoint(entry: ProviderEntry): Promise<Endpoint>
  saveKey(name: string, value: string): Promise<void>
  deleteKey(name: string): Promise<boolean>
  /** Names of the secrets already in the vault (never their values). */
  secretNames(): Promise<string[]>
  keyState(entry: ProviderEntry): Promise<'vault' | 'env' | 'none' | 'not needed'>
  mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>
}

const MODEL_RE = /^[\w.:/@+\-[\] ]{1,200}$/
const MIN = 60_000

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const int = (v: unknown, min: number, max: number): number | undefined => {
  const n = num(v)
  return n !== undefined && Number.isInteger(n) && n >= min && n <= max ? n : undefined
}
const text = (v: unknown, max = 500): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

/**
 * Owner-only management of providers, models, settings, skills and MCP servers — what the
 * terminal has in /providers, /settings, /skills and /mcp. Every change goes through one
 * serialised queue (`update`) so two clicks can never overwrite each other, and secrets only
 * ever travel one way: into the vault. No key is ever returned.
 */
export class Manager {
  private queue: Promise<unknown> = Promise.resolve()
  /** OAuth sign-ins in progress (one per connector). Holds an address, never a token. */
  private logins = new Map<string, { handle: LoginHandle; state: 'pending' | 'done' | 'error'; error: string; authUrl: string; redirectUri: string }>()

  constructor(private readonly d: ManagerDeps) {}

  /** Apply `fn` to the latest config, one change at a time. */
  private update(fn: (c: VaraConfig) => VaraConfig): Promise<VaraConfig> {
    const run = async (): Promise<VaraConfig> => {
      const next = fn(this.d.config())
      await this.d.apply(next)
      return next
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => {})
    return p
  }

  private async guard<T>(fn: () => Promise<T>): Promise<MResult<T>> {
    try {
      return good(await fn())
    } catch (err) {
      return bad(scrubAll((err as Error).message))
    }
  }

  /* ---------------- providers ---------------- */

  async providers(): Promise<unknown> {
    const cfg = this.d.config()
    const active = activeProviderName(cfg)
    const rows = await Promise.all(
      Object.entries(cfg.providers).map(async ([name, e]) => ({
        name,
        label: e.label ?? findPreset(name)?.label ?? name,
        type: e.type,
        baseUrl: e.baseUrl,
        keyless: e.keyless,
        key: await this.d.keyState(e).catch(() => 'none' as const),
        active: name === active,
        models: Object.entries(e.models).map(([id, m]) => {
          const t = thinkingFor(cfg, id, name)
          const ctx = contextOrigin(cfg, name, id)
          return {
            id,
            status: m.status,
            ...(m.statusDetail ? { statusDetail: scrubAll(m.statusDetail) } : {}),
            ...(m.checkedAt ? { checkedAt: m.checkedAt } : {}),
            active: name === active && id === cfg.provider.model,
            contextTokens: ctx.windowTokens,
            contextOrigin: ctx.origin,
            ...(m.maxOutputTokens ? { maxOutputTokens: m.maxOutputTokens } : {}),
            thinking: t.support ? { levels: t.support.levels, level: t.level ?? t.support.default, note: t.support.note } : null,
          }
        }),
      })),
    )
    return {
      active: { name: active, model: cfg.provider.model },
      providers: rows,
      presets: PRESETS.map((p) => ({ name: p.name, label: p.label, type: p.type, baseUrl: p.baseUrl, keyless: p.keyless === true, note: p.note, added: !!cfg.providers[p.name] })),
    }
  }

  async addProvider(body: Record<string, unknown>): Promise<MResult<unknown>> {
    const apiKey = text(body['apiKey'], 4_000)
    let name = ''
    const res = await this.guard(async () => {
      await this.update((c) => {
        const presetName = text(body['preset'], 40)
        if (presetName) {
          const preset = findPreset(presetName)
          if (!preset) throw new Error(`Unknown preset "${presetName}".`)
          if (c.providers[preset.name]) throw new Error(`"${preset.name}" is already added.`)
          name = preset.name
          return addProviderFromPreset(c, preset)
        }
        const custom = (body['custom'] ?? {}) as Record<string, unknown>
        name = text(custom['name'], 40).toLowerCase()
        const type = custom['type'] === 'anthropic' ? 'anthropic' : 'openai'
        return addCustomProvider(c, { name, type, baseUrl: text(custom['baseUrl'], 300), keyless: custom['keyless'] === true })
      })
      if (apiKey) await this.setKey(name, apiKey)
    })
    return res.ok ? good(await this.providers()) : res
  }

  private async setKey(name: string, key: string): Promise<void> {
    const entry = this.d.config().providers[name]
    if (!entry) throw new Error(`Unknown provider "${name}".`)
    if (entry.keyless) throw new Error('This provider needs no key.')
    const secret = entry.apiKeySecret || secretNameFor(name)
    await this.d.saveKey(secret, key)
    // The active provider is rebuilt so the new key works immediately.
    if (name === activeProviderName(this.d.config())) await this.update((c) => c)
    // A provider added without a secret name gets one now.
    if (!entry.apiKeySecret) await this.update((c) => ({ ...c, providers: { ...c.providers, [name]: { ...c.providers[name]!, apiKeySecret: secret } } }))
  }

  async putKey(name: string, body: Record<string, unknown>): Promise<MResult<unknown>> {
    const key = text(body['apiKey'], 4_000)
    if (!key) return bad('Paste the API key first.')
    const r = await this.guard(() => this.setKey(name, key))
    return r.ok ? good(await this.providers()) : r
  }

  async deleteProviderKey(name: string): Promise<MResult<unknown>> {
    const entry = this.d.config().providers[name]
    if (!entry) return bad('No such provider.', 404)
    if (entry.apiKeySecret) await this.d.deleteKey(entry.apiKeySecret).catch(() => false)
    return good(await this.providers())
  }

  async removeProvider(name: string): Promise<MResult<unknown>> {
    if (!this.d.config().providers[name]) return bad('No such provider.', 404)
    const r = await this.guard(() => this.update((c) => removeProvider(c, name)))
    return r.ok ? good(await this.providers()) : r
  }

  /** Fetch the provider's own model list and merge it in. */
  async refresh(name: string): Promise<MResult<unknown>> {
    const entry = this.d.config().providers[name]
    if (!entry) return bad('No such provider.', 404)
    let found: FoundModel[]
    try {
      found = await this.d.discover(await this.d.endpoint(entry))
    } catch (err) {
      return bad(scrubAll((err as Error).message), 502)
    }
    const r = await this.guard(() => this.update((c) => mergeDiscovered(c, name, found)))
    return r.ok ? good({ found: found.length, ...((await this.providers()) as object) }) : r
  }

  /** Prove one model (or all of them, a few at a time) with a real tiny request. */
  async test(name: string, body: Record<string, unknown>): Promise<MResult<unknown>> {
    const entry = this.d.config().providers[name]
    if (!entry) return bad('No such provider.', 404)
    const one = text(body['model'], 200)
    const ids = one ? [one] : Object.keys(entry.models).slice(0, 40)
    if (!ids.length) return bad('This provider has no models yet. Fetch the list first.')
    let ep: Endpoint
    try {
      ep = await this.d.endpoint(entry)
    } catch (err) {
      return bad(scrubAll((err as Error).message))
    }
    const results = await this.d.mapLimit(ids, 4, async (id) => ({ id, r: await this.d.check(ep, id) }))
    const r = await this.guard(() =>
      this.update((c) => {
        let next = c
        for (const { id, r } of results) if (next.providers[name]?.models[id]) next = setModelStatus(next, name, id, r.status, scrubAll(r.detail))
        return next
      }),
    )
    return r.ok ? good(await this.providers()) : r
  }

  /** add / remove / context / thinking for one model. */
  async model(name: string, body: Record<string, unknown>): Promise<MResult<unknown>> {
    const entry = this.d.config().providers[name]
    if (!entry) return bad('No such provider.', 404)
    const action = text(body['action'], 20)
    const id = text(body['id'], 200)
    if (!id || !MODEL_RE.test(id)) return bad('Model id looks wrong.')
    const r = await this.guard(() =>
      this.update((c) => {
        if (action === 'add') return addModel(c, name, id)
        if (action === 'remove') return removeModel(c, name, id)
        if (!c.providers[name]?.models[id]) throw new Error('No such model.')
        if (action === 'context') {
          const patch: { contextWindow?: number | null; maxOutputTokens?: number | null } = {}
          if ('contextWindow' in body) patch.contextWindow = body['contextWindow'] === null ? null : (int(body['contextWindow'], 512, 20_000_000) ?? (() => { throw new Error('Context window: a whole number of tokens (e.g. 128000).') })())
          if ('maxOutputTokens' in body) patch.maxOutputTokens = body['maxOutputTokens'] === null ? null : (int(body['maxOutputTokens'], 16, 2_000_000) ?? (() => { throw new Error('Max output: a whole number of tokens.') })())
          return setModelContext(c, name, id, patch)
        }
        if (action === 'thinking') {
          const level = body['level'] as ThinkLevel
          const support = thinkingFor(c, id, name).support
          if (!support) throw new Error(`${id} has no thinking control on this endpoint.`)
          if (!THINK_ORDER.includes(level) || !support.levels.includes(level)) throw new Error(`${id} supports: ${support.levels.join(', ')}`)
          return setModelThinking(c, name, id, level)
        }
        throw new Error('Unknown action.')
      }),
    )
    return r.ok ? good(await this.providers()) : r
  }

  /** Make a provider + model the one new sessions use. */
  async activate(body: Record<string, unknown>): Promise<MResult<unknown>> {
    const name = text(body['name'], 40)
    const entry = this.d.config().providers[name]
    if (!entry) return bad('No such provider.', 404)
    const model = text(body['model'], 200) || defaultModelFor(entry)
    if (!model) return bad('Pick a model, or fetch the list first.')
    const r = await this.guard(() => this.update((c) => activate(c, name, model)))
    return r.ok ? good(await this.providers()) : r
  }

  /* ---------------- settings ---------------- */

  settings(): unknown {
    const c = this.d.config()
    const b = (k: 'task' | 'goal') => ({ maxTurns: c.budgets[k].maxTurns, maxMinutes: Math.round(c.budgets[k].maxDurationMs / MIN), maxModelCalls: c.budgets[k].maxModelCalls })
    return {
      agent: { autoIntent: c.agent.autoIntent, defaultMode: c.agent.defaultMode, cheapModel: c.agent.cheapModel, browser: c.agent.browser, desktop: c.agent.desktop },
      defaultVerifyCommand: c.defaultVerifyCommand,
      allowPublish: c.allowPublish,
      swarm: { maxTasks: c.swarm.maxTasks, maxParallel: c.swarm.maxParallel, maxModelCalls: c.swarm.maxModelCalls, maxCostUsd: c.swarm.maxCostUsd },
      updates: { check: c.updates.check },
      budgets: { task: b('task'), goal: b('goal') },
      context: { windowTokens: c.context.windowTokens ?? null, maxOutputTokens: c.context.maxOutputTokens },
    }
  }

  async patchSettings(body: Record<string, unknown>): Promise<MResult<unknown>> {
    const r = await this.guard(() =>
      this.update((c) => {
        let n = c
        const agent = body['agent'] as Record<string, unknown> | undefined
        if (agent) {
          n = { ...n, agent: { ...n.agent } }
          if (typeof agent['autoIntent'] === 'boolean') n.agent.autoIntent = agent['autoIntent']
          if (typeof agent['browser'] === 'boolean') n.agent.browser = agent['browser']
          if (typeof agent['desktop'] === 'boolean') n.agent.desktop = agent['desktop']
          if (agent['defaultMode'] === 'plan' || agent['defaultMode'] === 'build') n.agent.defaultMode = agent['defaultMode']
          if (typeof agent['cheapModel'] === 'string') n.agent.cheapModel = text(agent['cheapModel'], 200)
        }
        if (typeof body['defaultVerifyCommand'] === 'string') n = { ...n, defaultVerifyCommand: text(body['defaultVerifyCommand'], 500) }
        if (typeof body['allowPublish'] === 'boolean') n = { ...n, allowPublish: body['allowPublish'] }
        const swarm = body['swarm'] as Record<string, unknown> | undefined
        if (swarm) {
          const next = { ...n.swarm }
          if ('maxTasks' in swarm) next.maxTasks = int(swarm['maxTasks'], 1, 4) ?? (() => { throw new Error('Tasks per call: a whole number from 1 to 4.') })()
          if ('maxParallel' in swarm) next.maxParallel = int(swarm['maxParallel'], 1, 3) ?? (() => { throw new Error('At the same time: a whole number from 1 to 3.') })()
          if ('maxModelCalls' in swarm) next.maxModelCalls = int(swarm['maxModelCalls'], 1, 1_000_000) ?? (() => { throw new Error('Model calls: a whole number >= 1.') })()
          if ('maxCostUsd' in swarm) {
            const v = swarm['maxCostUsd']
            if (v === null) next.maxCostUsd = null
            else if (typeof v === 'number' && Number.isFinite(v) && v > 0) next.maxCostUsd = v
            else throw new Error('Cost cap: a positive amount in USD, or empty for none.')
          }
          n = { ...n, swarm: next }
        }
        const updates = body['updates'] as Record<string, unknown> | undefined
        if (updates && typeof updates['check'] === 'boolean') n = { ...n, updates: { ...n.updates, check: updates['check'] } }
        const budgets = body['budgets'] as Record<string, Record<string, unknown>> | undefined
        if (budgets) {
          const next = { task: { ...n.budgets.task }, goal: { ...n.budgets.goal } }
          for (const k of ['task', 'goal'] as const) {
            const src = budgets[k]
            if (!src) continue
            if ('maxTurns' in src) next[k].maxTurns = int(src['maxTurns'], 1, 100_000) ?? (() => { throw new Error('Max turns: a whole number ≥ 1.') })()
            if ('maxMinutes' in src) next[k].maxDurationMs = (int(src['maxMinutes'], 1, 100_000) ?? (() => { throw new Error('Max minutes: a whole number ≥ 1.') })()) * MIN
            if ('maxModelCalls' in src) next[k].maxModelCalls = int(src['maxModelCalls'], 1, 1_000_000) ?? (() => { throw new Error('Max model calls: a whole number ≥ 1.') })()
          }
          n = { ...n, budgets: next }
        }
        const ctx = body['context'] as Record<string, unknown> | undefined
        if (ctx) {
          const next = { ...n.context }
          if ('windowTokens' in ctx) {
            if (ctx['windowTokens'] === null) delete next.windowTokens
            else next.windowTokens = int(ctx['windowTokens'], 512, 20_000_000) ?? (() => { throw new Error('Context window: a whole number of tokens, or empty for automatic.') })()
          }
          if ('maxOutputTokens' in ctx) next.maxOutputTokens = int(ctx['maxOutputTokens'], 16, 2_000_000) ?? (() => { throw new Error('Reserved output: a whole number of tokens.') })()
          n = { ...n, context: next }
        }
        return n
      }),
    )
    return r.ok ? good(this.settings()) : r
  }

  /* ---------------- skills ---------------- */

  async skills(): Promise<unknown> {
    const all = await discoverAllSkills(this.d.cwd, this.d.config().skills.disabled)
    return all.map((s) => ({ name: s.name, description: s.description, source: s.source, enabled: s.enabled, body: s.body, editable: s.source !== 'builtin' }))
  }

  async createSkill(body: Record<string, unknown>): Promise<MResult<unknown>> {
    const name = text(body['name'], 40).toLowerCase()
    if (!validSkillName(name)) return bad('Skill name: lowercase letters, digits, "-" or "_" (max 40).')
    const scope = body['scope'] === 'project' ? 'project' : 'user'
    const r = await this.guard(() => scaffoldSkill(name, scope, this.d.cwd))
    return r.ok ? good(await this.skills()) : r
  }

  async patchSkill(name: string, body: Record<string, unknown>): Promise<MResult<unknown>> {
    const all = await discoverAllSkills(this.d.cwd, this.d.config().skills.disabled)
    const skill = all.find((s) => s.name === name)
    if (!skill) return bad('No such skill.', 404)
    if (typeof body['content'] === 'string') {
      if (skill.source === 'builtin' || !skill.path || !existsSync(skill.path)) return bad('Built-in skills cannot be edited. Create your own with the same name to override it.')
      const content = String(body['content']).slice(0, 100_000)
      if (!content.trim()) return bad('A skill cannot be empty.')
      await writeFile(skill.path, content, 'utf8')
    }
    if (typeof body['enabled'] === 'boolean') {
      const r = await this.guard(() =>
        this.update((c) => {
          const off = new Set(c.skills.disabled)
          if (body['enabled']) off.delete(name)
          else off.add(name)
          return { ...c, skills: { ...c.skills, disabled: [...off] } }
        }),
      )
      if (!r.ok) return r
    }
    return good(await this.skills())
  }

  /** The raw file of an editable skill (front matter included), for the editor. */
  async skillSource(name: string): Promise<MResult<{ content: string }>> {
    const all = await discoverAllSkills(this.d.cwd, [])
    const skill = all.find((s) => s.name === name)
    if (!skill) return bad('No such skill.', 404)
    if (skill.path && existsSync(skill.path)) return good({ content: await readFile(skill.path, 'utf8') })
    return good({ content: `---\nname: ${skill.name}\ndescription: ${skill.description}\n---\n${skill.body}\n` })
  }

  /* ---------------- MCP ---------------- */

  mcp(): unknown {
    const servers = this.d.config().mcp.servers as Record<string, McpServerConfig>
    return {
      servers: this.d.hub.view(servers).map((v) => ({
        name: v.name,
        status: v.status,
        tools: v.tools,
        error: scrubAll(v.error),
        enabled: v.config.enabled !== false,
        kind: v.config.url ? 'remote' : 'local',
        target: v.config.url ?? [v.config.command, ...(v.config.args ?? [])].join(' '),
        toolList: v.status === 'ready' ? this.d.hub.toolsOf(v.name) : [],
      })),
      presets: MCP_PRESETS.map((p) => ({ name: p.name, label: p.label, note: p.note, added: !!servers[p.name] })),
    }
  }

  async addMcp(body: Record<string, unknown>): Promise<MResult<unknown>> {
    const presetName = text(body['preset'], 40)
    let name = text(body['name'], 31)
    let server: McpServerConfig | string
    if (presetName) {
      const preset = MCP_PRESETS.find((p) => p.name === presetName)
      if (!preset) return bad('Unknown preset.')
      name = preset.name
      server = { ...preset.config, enabled: true }
    } else {
      server = serverFromInput(text(body['input'], 2_000))
    }
    if (typeof server === 'string') return bad(server)
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/.test(name)) return bad('Name: letters, digits, "-" or "_" (max 31).')
    const r = await this.guard(() =>
      this.update((c) => {
        if (c.mcp.servers[name]) throw new Error(`"${name}" already exists.`)
        return { ...c, mcp: { ...c.mcp, servers: { ...c.mcp.servers, [name]: { args: [], env: {}, secretEnv: [], headers: {}, ...server, enabled: true } as never } } }
      }),
    )
    return r.ok ? good(this.mcp()) : r
  }

  async patchMcp(name: string, body: Record<string, unknown>): Promise<MResult<unknown>> {
    if (!this.d.config().mcp.servers[name]) return bad('No such server.', 404)
    if (body['reconnect'] === true) {
      await this.d.hub.reconnect(name).catch(() => {})
      return good(this.mcp())
    }
    if (typeof body['enabled'] !== 'boolean') return bad('Nothing to change.')
    const r = await this.guard(() => this.update((c) => ({ ...c, mcp: { ...c.mcp, servers: { ...c.mcp.servers, [name]: { ...c.mcp.servers[name]!, enabled: body['enabled'] === true } } } })))
    return r.ok ? good(this.mcp()) : r
  }

  async removeMcp(name: string): Promise<MResult<unknown>> {
    if (!this.d.config().mcp.servers[name]) return bad('No such server.', 404)
    const r = await this.guard(() =>
      this.update((c) => {
        const { [name]: _gone, ...rest } = c.mcp.servers
        return { ...c, mcp: { ...c.mcp, servers: rest } }
      }),
    )
    if (r.ok && findConnector(name)?.oauth) await oauthLogout(name).catch(() => {})
    return r.ok ? good(this.mcp()) : r
  }

  /* ---------------- modes ---------------- */

  modes(): unknown {
    return Object.entries(this.d.config().modes).map(([name, m]) => ({ name, ...m }))
  }

  /** Create or replace one custom mode. A mode can only narrow its base (plan / build). */
  async putMode(name: string, body: Record<string, unknown>): Promise<MResult<unknown>> {
    if (!validModeName(name)) return bad('Mode name: lowercase letters, digits, "-" or "_" (max 30), not plan/build.')
    const list = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.map((x) => text(x, max)).filter(Boolean).slice(0, 100) : [])
    const def: ModeDef = {
      description: text(body['description'], 300),
      base: body['base'] === 'plan' ? 'plan' : 'build',
      allowTools: list(body['allowTools'], 80),
      denyTools: list(body['denyTools'], 80),
      allowCommands: list(body['allowCommands'], 200),
      denyCommands: list(body['denyCommands'], 200),
    }
    const r = await this.guard(() => this.update((c) => ({ ...c, modes: { ...c.modes, [name]: def } })))
    return r.ok ? good(this.modes()) : r
  }

  async deleteMode(name: string): Promise<MResult<unknown>> {
    if (!this.d.config().modes[name]) return bad('No such mode.', 404)
    const r = await this.guard(() =>
      this.update((c) => {
        const { [name]: _gone, ...rest } = c.modes
        return { ...c, modes: rest }
      }),
    )
    return r.ok ? good(this.modes()) : r
  }

  /* ---------------- connectors ---------------- */

  async connectors(): Promise<unknown> {
    const have = new Set(await this.d.secretNames().catch(() => [] as string[]))
    const servers = this.d.config().mcp.servers as Record<string, McpServerConfig>
    const views = new Map(this.d.hub.view(servers).map((v) => [v.name, v]))
    const signed = new Map<string, Awaited<ReturnType<typeof oauthStatus>>>()
    for (const c of CONNECTORS) if (c.oauth) signed.set(c.id, await oauthStatus(c.id))
    return CONNECTORS.map((c) => {
      const v = views.get(c.id)
      const login = this.logins.get(c.id)
      const st = signed.get(c.id)
      return {
        ...(c.oauth
          ? {
              oauth: {
                client: c.oauth.client,
                signedIn: !!st?.signedIn,
                canRefresh: !!st?.canRefresh,
                ...(st?.expiresAt ? { expiresAt: st.expiresAt } : {}),
                login: login ? { state: login.state, error: login.error } : null,
              },
            }
          : {}),
        id: c.id,
        name: c.name,
        category: c.category,
        description: c.description,
        checked: c.checked,
        secrets: c.secrets.map((s) => ({ ...s, stored: have.has(s.name) })),
        added: !!servers[c.id],
        enabled: !!v && v.config.enabled !== false,
        status: v?.status ?? null,
        tools: v?.tools ?? 0,
        error: v ? scrubAll(v.error) : '',
      }
    })
  }

  /** Add a connector: store the secrets it needs (values go only into the vault), then add its MCP server. */
  async addConnector(body: Record<string, unknown>): Promise<MResult<unknown>> {
    const c = findConnector(text(body['id'], 40))
    if (!c) return bad('Unknown connector.', 404)
    if (this.d.config().mcp.servers[c.id]) return bad(`"${c.name}" is already connected.`, 409)
    if (c.oauth) return bad(`"${c.name}" signs in with your browser — use Sign in.`)
    const given = (body['secrets'] ?? {}) as Record<string, unknown>
    const have = new Set(await this.d.secretNames().catch(() => [] as string[]))
    for (const s of c.secrets) {
      const v = typeof given[s.name] === 'string' ? String(given[s.name]).trim() : ''
      if (v) await this.d.saveKey(s.name, v)
      else if (!have.has(s.name)) return bad(`${s.label} is needed. ${s.help}`)
    }
    const r = await this.guard(() => this.update((cfg) => ({ ...cfg, mcp: { ...cfg.mcp, servers: { ...cfg.mcp.servers, [c.id]: connectorServer(c) as never } } })))
    return r.ok ? good(await this.connectors()) : r
  }

  /* ---------------- OAuth sign-in ---------------- */

  private oauthConnector(id: string): { c: Connector } | { err: MResult<never> } {
    const c = findConnector(id)
    if (!c) return { err: bad('Unknown connector.', 404) }
    if (!c.oauth) return { err: bad(`"${c.name}" does not use a browser sign-in.`) }
    return { c }
  }

  /** Start a sign-in. The reply holds the address to open in a browser — no token ever. Poll `loginStatus`. */
  async startLogin(id: string, body: Record<string, unknown> = {}): Promise<MResult<unknown>> {
    const r = this.oauthConnector(id)
    if ('err' in r) return r.err
    const { c } = r
    this.logins.get(c.id)?.handle.cancel()
    const port = int(body['port'], 1024, 65535)
    let handle: LoginHandle
    try {
      handle = await beginLogin({ id: c.id, resourceUrl: c.config.url!, ...(c.oauth!.scope ? { scope: c.oauth!.scope } : {}), ...(port ? { port } : {}), clientName: 'VARA' })
    } catch (err) {
      return bad(scrubAll((err as Error).message), 502)
    }
    const entry = { handle, state: 'pending' as 'pending' | 'done' | 'error', error: '', authUrl: handle.authUrl, redirectUri: handle.redirectUri }
    this.logins.set(c.id, entry)
    handle.done.then(
      async () => {
        try {
          await this.afterLogin(c)
          if (this.logins.get(c.id) === entry) entry.state = 'done'
        } catch (err) {
          entry.state = 'error'
          entry.error = scrubAll((err as Error).message)
        }
      },
      (err: Error) => {
        if (this.logins.get(c.id) === entry) {
          entry.state = 'error'
          entry.error = scrubAll(err.message)
        }
      },
    )
    return good({ authUrl: entry.authUrl, redirectUri: entry.redirectUri })
  }

  /** Signed in: make sure the server entry exists (with `oauth`) and that it reconnects with the new token. */
  private async afterLogin(c: Connector): Promise<void> {
    if (this.d.config().mcp.servers[c.id]) {
      await this.d.hub.reconnect(c.id).catch(() => {})
      return
    }
    const r = await this.guard(() => this.update((cfg) => ({ ...cfg, mcp: { ...cfg.mcp, servers: { ...cfg.mcp.servers, [c.id]: connectorServer(c) as never } } })))
    if (!r.ok) throw new Error(r.error)
  }

  loginStatus(id: string): MResult<unknown> {
    const r = this.oauthConnector(id)
    if ('err' in r) return r.err
    const l = this.logins.get(r.c.id)
    return good(l ? { state: l.state, error: l.error, redirectUri: l.redirectUri } : { state: 'none', error: '' })
  }

  /** Headless fallback: the owner pastes the address their browser ended up on. */
  async loginCode(id: string, body: Record<string, unknown>): Promise<MResult<unknown>> {
    const r = this.oauthConnector(id)
    if ('err' in r) return r.err
    const l = this.logins.get(r.c.id)
    if (!l || l.state !== 'pending') return bad('No sign-in is waiting. Press Connect again.', 409)
    const pasted = text(body['pasted'], 4_000)
    if (!pasted) return bad('Paste the address from your browser after approving.')
    try {
      await l.handle.submitPasted(pasted)
    } catch (err) {
      return bad(scrubAll((err as Error).message))
    }
    return good(this.loginStatus(id))
  }

  cancelLogin(id: string): MResult<unknown> {
    const r = this.oauthConnector(id)
    if ('err' in r) return r.err
    this.logins.get(r.c.id)?.handle.cancel()
    this.logins.delete(r.c.id)
    return good({ state: 'none', error: '' })
  }

  /** Sign out: revoke at the service when it supports that, delete the stored tokens, drop the connection. */
  async logout(id: string): Promise<MResult<unknown>> {
    const r = this.oauthConnector(id)
    if ('err' in r) return r.err
    this.logins.get(r.c.id)?.handle.cancel()
    this.logins.delete(r.c.id)
    const out = await oauthLogout(r.c.id)
    if (this.d.config().mcp.servers[r.c.id]) await this.d.hub.reconnect(r.c.id).catch(() => {})
    return good({ revoked: out.revoked, wasSignedIn: out.was, connectors: await this.connectors() })
  }

  /* ---------------- routing ---------------- */

  /** `parts` = path segments after /api/manage. */
  async route(method: string, parts: string[], body: Record<string, unknown>): Promise<MResult<unknown>> {
    const [a, b, c, d] = parts
    const dec = (s: string | undefined): string => {
      try {
        return decodeURIComponent(s ?? '')
      } catch {
        return ''
      }
    }
    if (a === 'providers') {
      if (!b && method === 'GET') return good(await this.providers())
      if (!b && method === 'POST') return this.addProvider(body)
      if (b === 'activate' && method === 'POST') return this.activate(body)
      const name = dec(b)
      if (b && !c && method === 'DELETE') return this.removeProvider(name)
      if (b && c === 'key' && method === 'PUT') return this.putKey(name, body)
      if (b && c === 'key' && method === 'DELETE') return this.deleteProviderKey(name)
      if (b && c === 'refresh' && method === 'POST') return this.refresh(name)
      if (b && c === 'test' && method === 'POST') return this.test(name, body)
      if (b && c === 'model' && method === 'POST') return this.model(name, body)
    }
    if (a === 'settings') {
      if (method === 'GET') return good(this.settings())
      if (method === 'PATCH') return this.patchSettings(body)
    }
    if (a === 'cost') {
      if (!b && method === 'GET') return good(costBoard(this.d.config(), sharedMeter()))
      if (!b && method === 'PATCH') {
        const r = await this.guard(() => this.update((c) => applyCostPatch(c, body)))
        return r.ok ? good(costBoard(this.d.config(), sharedMeter())) : r
      }
    }
    if (a === 'skills') {
      if (!b && method === 'GET') return good(await this.skills())
      if (!b && method === 'POST') return this.createSkill(body)
      if (b && c === 'source' && method === 'GET') return this.skillSource(dec(b))
      if (b && !c && method === 'PATCH') return this.patchSkill(dec(b), body)
    }
    if (a === 'modes') {
      if (!b && method === 'GET') return good(this.modes())
      if (b && !c && method === 'PUT') return this.putMode(dec(b), body)
      if (b && !c && method === 'DELETE') return this.deleteMode(dec(b))
    }
    if (a === 'connectors') {
      if (!b && method === 'GET') return good(await this.connectors())
      if (!b && method === 'POST') return this.addConnector(body)
      if (b && c === 'login' && !d) {
        if (method === 'POST') return this.startLogin(dec(b), body)
        if (method === 'GET') return this.loginStatus(dec(b))
        if (method === 'DELETE') return this.cancelLogin(dec(b))
      }
      if (b && c === 'login' && d === 'code' && method === 'POST') return this.loginCode(dec(b), body)
      if (b && c === 'logout' && method === 'POST') return this.logout(dec(b))
    }
    if (a === 'mcp') {
      if (!b && method === 'GET') return good(this.mcp())
      if (!b && method === 'POST') return this.addMcp(body)
      if (b && !c && method === 'PATCH') return this.patchMcp(dec(b), body)
      if (b && !c && method === 'DELETE') return this.removeMcp(dec(b))
    }
    return bad('not found', 404)
  }
}

export { validProviderName }
