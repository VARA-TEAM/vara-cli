import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { ensureProviders } from '../src/config/providers.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { Manager, type ManagerDeps } from '../src/server/manage.js'
import { newOwnerToken, startServer, type RunningServer } from '../src/server/http.js'

class Echo implements Provider {
  id = 'openai' as const
  async *chat(): AsyncIterable<ProviderEvent> {
    const turn: AssistantTurn = { content: 'hi there', toolCalls: [] }
    yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

let dir: string
let work: string
let config: VaraConfig
let applied = 0
let failApply: string | null = null
const keys = new Map<string, string>()
let manager: Manager
let host: VaraHost
let server: RunningServer
let base: string
const ownerToken = newOwnerToken()

const deps = (): ManagerDeps => ({
  config: () => config,
  apply: async (next) => {
    if (failApply) throw new Error(failApply)
    config = next
    applied++
  },
  hub: new McpHub(),
  cwd: work,
  discover: async () => [
    { id: 'big-model', contextWindow: 200_000, maxOutputTokens: 8_000 },
    { id: 'small-model', contextWindow: 32_000 },
  ],
  check: async (_ep, model) => (model === 'small-model' ? { status: 'fail', detail: 'HTTP 404 — no such model sk-abcdefghijklmnopqrstuvwx', latencyMs: 5 } : { status: 'ok', detail: 'answered in 5ms', latencyMs: 5 }),
  endpoint: async (entry) => ({ type: entry.type, baseUrl: entry.baseUrl, apiKey: 'k' }),
  saveKey: async (name, value) => void keys.set(name, value),
  deleteKey: async (name) => keys.delete(name),
  keyState: async (entry) => (entry.keyless ? 'not needed' : keys.has(entry.apiKeySecret) ? 'vault' : 'none'),
  mapLimit: async (items, _limit, fn) => Promise.all(items.map(fn)),
})

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-mgr-'))
  work = await mkdtemp(join(tmpdir(), 'vara-mgr-work-'))
  config = ensureProviders({ ...DEFAULT_CONFIG })
  manager = new Manager(deps())
  host = new VaraHost({ config: () => config, provider: () => new Echo(), hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: work })
  server = await startServer({ host, manager, ownerToken, port: 0, limits: { failures: 10_000, joins: 10_000 } })
  base = `http://127.0.0.1:${server.port}`
})
afterAll(async () => {
  await host.closeAll()
  await server.close()
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const call = async (path: string, token: string | null, method = 'GET', json?: unknown) => {
  const res = await fetch(base + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  })
  const text = await res.text()
  let body: any = text
  try {
    body = JSON.parse(text)
  } catch {
    /* text */
  }
  return { status: res.status, body }
}

describe('manager — providers and models', () => {
  it('lists the active provider with models, context origin and presets', async () => {
    const r = (await manager.providers()) as any
    expect(r.active.name).toBe('openai')
    expect(r.providers[0].models.some((m: any) => m.active)).toBe(true)
    expect(r.presets.find((p: any) => p.name === 'openai').added).toBe(true)
    expect(r.presets.find((p: any) => p.name === 'groq').added).toBe(false)
  })

  it('adds a preset with its key; the key goes to the vault and never comes back', async () => {
    const r = await manager.addProvider({ preset: 'groq', apiKey: 'gsk_secret_value_123456789' })
    expect(r.ok).toBe(true)
    expect(JSON.stringify(r)).not.toContain('gsk_secret_value')
    expect([...keys.values()]).toContain('gsk_secret_value_123456789')
    const groq = ((r as any).value.providers as any[]).find((p) => p.name === 'groq')
    expect(groq.key).toBe('vault')
  })

  it('refuses duplicates, bad custom names and bad URLs with a clear message', async () => {
    expect(await manager.addProvider({ preset: 'groq' })).toMatchObject({ ok: false, error: expect.stringContaining('already added') })
    expect(await manager.addProvider({ custom: { name: 'Bad Name', baseUrl: 'https://x.dev/v1' } })).toMatchObject({ ok: false })
    expect(await manager.addProvider({ custom: { name: 'mine', baseUrl: 'ftp://x' } })).toMatchObject({ ok: false, error: expect.stringContaining('http') })
    expect((await manager.addProvider({ custom: { name: 'mine', type: 'openai', baseUrl: 'https://llm.example.com/v1/' } })).ok).toBe(true)
    expect(config.providers['mine']!.baseUrl).toBe('https://llm.example.com/v1')
  })

  it('fetches the provider model list and keeps manual settings', async () => {
    await manager.model('groq', { action: 'context', id: 'llama-3.3-70b-versatile', contextWindow: 12_345 })
    const r = (await manager.refresh('groq')) as any
    expect(r.ok).toBe(true)
    expect(r.value.found).toBe(2)
    const ids = Object.keys(config.providers['groq']!.models)
    expect(ids).toEqual(expect.arrayContaining(['big-model', 'small-model', 'llama-3.3-70b-versatile']))
    expect(config.providers['groq']!.models['llama-3.3-70b-versatile']!.contextWindow).toBe(12_345)
    expect(config.providers['groq']!.models['big-model']!.contextWindow).toBe(200_000)
  })

  it('tests models for real and scrubs secrets out of failure details', async () => {
    const r = (await manager.test('groq', {})) as any
    expect(r.ok).toBe(true)
    const rows = r.value.providers.find((p: any) => p.name === 'groq').models
    expect(rows.find((m: any) => m.id === 'big-model').status).toBe('ok')
    const bad = rows.find((m: any) => m.id === 'small-model')
    expect(bad.status).toBe('fail')
    expect(bad.statusDetail).not.toContain('sk-abcdefghijklmnopqrstuvwx')
  })

  it('activates a provider and refuses it when the host cannot build it (config is left unchanged)', async () => {
    const before = config
    failApply = 'No API key found.'
    expect(await manager.activate({ name: 'groq', model: 'big-model' })).toMatchObject({ ok: false, error: 'No API key found.' })
    expect(config).toBe(before)
    failApply = null
    expect((await manager.activate({ name: 'groq', model: 'big-model' })).ok).toBe(true)
    expect(config.provider).toMatchObject({ name: 'groq', model: 'big-model' })
    expect(await manager.activate({ name: 'nope' })).toMatchObject({ ok: false, status: 404 })
  })

  it('will not remove the provider or model in use, and validates context numbers', async () => {
    expect(await manager.removeProvider('groq')).toMatchObject({ ok: false })
    expect(await manager.model('groq', { action: 'remove', id: 'big-model' })).toMatchObject({ ok: false })
    expect(await manager.model('groq', { action: 'context', id: 'big-model', contextWindow: 'lots' })).toMatchObject({ ok: false })
    expect((await manager.model('groq', { action: 'context', id: 'big-model', contextWindow: null })).ok).toBe(true)
    expect(config.providers['groq']!.models['big-model']!.contextWindow).toBeUndefined()
    expect((await manager.removeProvider('mine')).ok).toBe(true)
  })

  it('thinking levels: only what the model supports', async () => {
    await manager.model('openai', { action: 'add', id: 'o3-mini' })
    const bad = await manager.model('openai', { action: 'thinking', id: 'gpt-4o', level: 'high' })
    expect(bad.ok).toBe(false)
    const ok = await manager.model('openai', { action: 'thinking', id: 'o3-mini', level: 'high' })
    expect(ok.ok).toBe(true)
    const m = ((ok as any).value.providers as any[]).find((p) => p.name === 'openai').models.find((x: any) => x.id === 'o3-mini')
    expect(m.thinking.level).toBe('high')
  })

  it('removing a key keeps the provider but shows it as keyless-missing', async () => {
    const r = (await manager.deleteProviderKey('groq')) as any
    expect(r.value.providers.find((p: any) => p.name === 'groq').key).toBe('none')
  })

  it('serialises concurrent edits: none is lost', async () => {
    await Promise.all(['a1', 'a2', 'a3', 'a4', 'a5'].map((id) => manager.model('openai', { action: 'add', id })))
    expect(Object.keys(config.providers['openai']!.models)).toEqual(expect.arrayContaining(['a1', 'a2', 'a3', 'a4', 'a5']))
  })
})

describe('manager — settings', () => {
  it('reads and patches budgets, agent, verify command and context', async () => {
    const r = await manager.patchSettings({
      agent: { cheapModel: 'small-model', autoIntent: false, defaultMode: 'plan' },
      defaultVerifyCommand: 'npm test',
      allowPublish: true,
      budgets: { task: { maxTurns: 10, maxMinutes: 5, maxModelCalls: 50 } },
      context: { windowTokens: 100_000, maxOutputTokens: 2048 },
    })
    expect(r.ok).toBe(true)
    expect(config.agent).toMatchObject({ cheapModel: 'small-model', autoIntent: false, defaultMode: 'plan' })
    expect(config.budgets.task).toEqual({ maxTurns: 10, maxDurationMs: 300_000, maxModelCalls: 50 })
    expect(config.context).toMatchObject({ windowTokens: 100_000, maxOutputTokens: 2048 })
    expect(config.defaultVerifyCommand).toBe('npm test')
    expect((await manager.patchSettings({ context: { windowTokens: null } })).ok).toBe(true)
    expect(config.context.windowTokens).toBeUndefined()
  })

  it('rejects nonsense with a message that names the field and changes nothing', async () => {
    const before = config
    expect(await manager.patchSettings({ budgets: { task: { maxTurns: 0 } } })).toMatchObject({ ok: false, error: expect.stringContaining('Max turns') })
    expect(await manager.patchSettings({ budgets: { goal: { maxMinutes: 'x' } } })).toMatchObject({ ok: false })
    expect(config).toBe(before)
  })
})

describe('manager — skills and MCP', () => {
  it('lists built-in skills, creates a project skill, edits it and toggles it', async () => {
    const list = (await manager.skills()) as any[]
    expect(list.some((s) => s.source === 'builtin' && !s.editable)).toBe(true)
    expect((await manager.createSkill({ name: 'My Skill!' })).ok).toBe(false)
    expect((await manager.createSkill({ name: 'release-notes-x', scope: 'project' })).ok).toBe(true)
    expect((await manager.createSkill({ name: 'release-notes-x', scope: 'project' })).ok).toBe(false)
    const src = (await manager.skillSource('release-notes-x')) as any
    expect(src.value.content).toContain('name: release-notes-x')
    const edited = src.value.content.replace('One line — WHEN should the agent use this skill?', 'Use when writing release notes')
    expect((await manager.patchSkill('release-notes-x', { content: edited })).ok).toBe(true)
    const after = ((await manager.skills()) as any[]).find((s) => s.name === 'release-notes-x')
    expect(after.description).toBe('Use when writing release notes')
    await manager.patchSkill('release-notes-x', { enabled: false })
    expect(config.skills.disabled).toContain('release-notes-x')
    expect(((await manager.skills()) as any[]).find((s) => s.name === 'release-notes-x').enabled).toBe(false)
    expect((await manager.patchSkill('debugging', { content: 'x' })).ok).toBe(false)
  })

  it('adds MCP servers from a preset, a command line and a URL; toggles and removes them', async () => {
    expect((await manager.addMcp({ preset: 'memory' })).ok).toBe(true)
    expect((await manager.addMcp({ name: 'docs', input: 'https://mcp.example.com/mcp' })).ok).toBe(true)
    expect((await manager.addMcp({ name: 'loc', input: 'node "my server.js" --x' })).ok).toBe(true)
    expect(config.mcp.servers['loc']!.args).toEqual(['my server.js', '--x'])
    expect(await manager.addMcp({ name: 'loc', input: 'node a.js' })).toMatchObject({ ok: false })
    expect(await manager.addMcp({ name: 'bad name', input: 'node a.js' })).toMatchObject({ ok: false })
    expect(await manager.addMcp({ name: 'x', input: '   ' })).toMatchObject({ ok: false })
    const r = (await manager.patchMcp('docs', { enabled: false })) as any
    expect(r.value.servers.find((s: any) => s.name === 'docs')).toMatchObject({ enabled: false, status: 'disabled', kind: 'remote' })
    expect((await manager.removeMcp('docs')).ok).toBe(true)
    expect(config.mcp.servers['docs']).toBeUndefined()
    expect(await manager.removeMcp('docs')).toMatchObject({ ok: false, status: 404 })
  })
})

describe('HTTP — who may manage what', () => {
  it('owner can; a guest cannot; no token cannot', async () => {
    const mk = await call('/api/admin/invites', ownerToken, 'POST', { preset: 'collaborator' })
    const joined = await call('/api/join', null, 'POST', { invite: mk.body.token, name: 'Sam' })
    const guest = joined.body.accessToken as string
    expect((await call('/api/manage/providers', ownerToken)).status).toBe(200)
    expect((await call('/api/manage/settings', ownerToken)).body.agent).toBeDefined()
    expect((await call('/api/manage/providers', guest)).status).toBe(403)
    expect((await call('/api/manage/settings', guest, 'PATCH', { allowPublish: true })).status).toBe(403)
    expect((await call('/api/manage/mcp', null)).status).toBe(401)
    expect((await call('/api/files?q=a', guest)).status).toBe(403)
    expect((await call('/api/manage/nothing', ownerToken)).status).toBe(404)
  })

  it('PUT key over HTTP stores it and never echoes it', async () => {
    const r = await call('/api/manage/providers/openai/key', ownerToken, 'PUT', { apiKey: 'sk-live-should-not-echo-123456' })
    expect(r.status).toBe(200)
    expect(JSON.stringify(r.body)).not.toContain('should-not-echo')
    expect(keys.get('OPENAI_API_KEY')).toBe('sk-live-should-not-echo-123456')
  })
})

describe('session extras', () => {
  it('insights, export, kind, stop and @file completion', async () => {
    await mkdir(join(work, 'src'), { recursive: true })
    await writeFile(join(work, 'src', 'alpha.ts'), 'export const a = 1\n')
    await writeFile(join(work, 'notes.md'), 'hello\n')
    const created = await call('/api/sessions', ownerToken, 'POST', { message: 'explain @src/alpha.ts please' })
    expect(created.status).toBe(200)
    const id = created.body.id as string
    // The title is what was typed; the file body is attached for the model only.
    expect(created.body.objective).toBe('explain @src/alpha.ts please')
    await new Promise((r) => setTimeout(r, 400))
    const s = await call(`/api/sessions/${id}`, ownerToken)
    expect(s.body.transcript[0].content).toContain('export const a = 1')
    expect(s.body.can.manage).toBe(true)

    const ins = await call(`/api/sessions/${id}/insights`, ownerToken)
    expect(ins.status).toBe(200)
    expect(ins.body.context.windowTokens).toBeGreaterThan(0)
    expect(ins.body.budget.maxTurns).toBeGreaterThan(0)
    expect(Array.isArray(ins.body.evidence)).toBe(true)

    const exp = await call(`/api/sessions/${id}/export`, ownerToken)
    expect(exp.body.markdown).toContain('## You')
    expect(exp.body.markdown).toContain('explain @src/alpha.ts please')
    expect(exp.body.markdown).not.toContain('export const a = 1')

    expect((await call(`/api/sessions/${id}/kind`, ownerToken, 'POST', { kind: 'goal' })).status).toBe(200)
    expect((await call(`/api/sessions/${id}/kind`, ownerToken, 'POST', { kind: 'nope' })).status).toBe(400)

    const files = await call('/api/files?q=alp', ownerToken)
    expect(files.body).toEqual(['src/alpha.ts'])
    expect((await call('/api/files?q=', ownerToken)).body).toEqual(expect.arrayContaining(['notes.md', 'src/alpha.ts']))

    expect((await call(`/api/sessions/${id}/stop`, ownerToken, 'POST', {})).status).toBe(200)
    expect((await call(`/api/sessions/${id}`, ownerToken)).body.state).toBe('stopped')
  })

  it('a guest cannot read the files of the host or change a session kind, and does not get @-expansion', async () => {
    const mk = await call('/api/admin/invites', ownerToken, 'POST', { preset: 'collaborator' })
    const guest = (await call('/api/join', null, 'POST', { invite: mk.body.token, name: 'Noor' })).body.accessToken as string
    const created = await call('/api/sessions', guest, 'POST', { message: 'look at @notes.md' })
    expect(created.status).toBe(200)
    await new Promise((r) => setTimeout(r, 300))
    const s = await call(`/api/sessions/${created.body.id}`, guest)
    expect(s.body.transcript[0].content).not.toContain('hello')
    expect(s.body.can.manage).toBe(false)
    expect((await call(`/api/sessions/${created.body.id}/kind`, guest, 'POST', { kind: 'goal' })).status).toBe(403)
  })
})

describe('working folder', () => {
  it('sessions are listed per folder; the owner can switch folder, browse, and see all', async () => {
    const other = await mkdtemp(join(tmpdir(), 'vara-other-'))
    await mkdir(join(other, 'child'), { recursive: true })
    try {
      const here = (await call('/api/sessions', ownerToken)).body as Array<{ cwd: string }>
      expect(here.every((s) => s.cwd === work)).toBe(true)
      const before = here.length

      expect((await call('/api/folder', ownerToken, 'POST', { path: join(other, 'missing') })).status).toBe(400)
      expect((await call('/api/folder', ownerToken, 'POST', { path: other })).body.current).toBe(other)

      expect(((await call('/api/sessions', ownerToken)).body as unknown[]).length).toBe(0)
      const made = await call('/api/sessions', ownerToken, 'POST', { message: 'hello in the other folder' })
      expect(made.status).toBe(200)
      expect(((await call('/api/sessions', ownerToken)).body as Array<{ cwd: string }>).every((s) => s.cwd === other)).toBe(true)
      expect(((await call('/api/sessions?all=1', ownerToken)).body as unknown[]).length).toBeGreaterThanOrEqual(before + 1)

      const info = (await call('/api/folder', ownerToken)).body as { current: string; recent: string[] }
      expect(info.current).toBe(other)
      expect(info.recent).toContain(work)
      const b = (await call(`/api/folder/browse?path=${encodeURIComponent(other)}`, ownerToken)).body as { dirs: string[]; parent: string | null }
      expect(b.dirs).toEqual(['child'])
      expect(b.parent).not.toBeNull()
      await call('/api/folder', ownerToken, 'POST', { path: work })
    } finally {
      await new Promise((r) => setTimeout(r, 200))
      await rm(other, { recursive: true, force: true })
    }
  })

  it('a guest can neither change nor browse folders, nor list every folder', async () => {
    const mk = await call('/api/admin/invites', ownerToken, 'POST', { preset: 'collaborator' })
    const guest = (await call('/api/join', null, 'POST', { invite: mk.body.token, name: 'Lina' })).body.accessToken as string
    expect((await call('/api/folder', guest)).status).toBe(403)
    expect((await call('/api/folder', guest, 'POST', { path: work })).status).toBe(403)
    expect((await call('/api/folder/browse?path=/', guest)).status).toBe(403)
    expect((await call('/api/sessions?all=1', guest)).status).toBe(200)
  })
})
