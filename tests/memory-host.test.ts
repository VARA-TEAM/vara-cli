import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { ensureProviders } from '../src/config/providers.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { Manager } from '../src/server/manage.js'
import { newOwnerToken, startServer, type RunningServer } from '../src/server/http.js'
import { createProposal, rejectProposal, listProposals } from '../src/core/proposals.js'
import { discoverSkills } from '../src/core/skills.js'

class Echo implements Provider {
  id = 'openai' as const
  async *chat(): AsyncIterable<ProviderEvent> {
    const turn: AssistantTurn = { content: 'hi', toolCalls: [] }
    yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

let dir: string
let work: string
let config: VaraConfig
let host: VaraHost
let server: RunningServer
let base: string
const ownerToken = newOwnerToken()

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-memhost-'))
  work = await mkdtemp(join(tmpdir(), 'vara-memhost-work-'))
  config = ensureProviders({ ...DEFAULT_CONFIG })
  const manager = new Manager({
    config: () => config,
    apply: async (next) => void (config = next),
    hub: new McpHub(),
    cwd: work,
    discover: async () => [],
    check: async () => ({ status: 'ok', detail: '', latencyMs: 1 }),
    endpoint: async (e) => ({ type: e.type, baseUrl: e.baseUrl, apiKey: 'k' }),
    saveKey: async () => {},
    deleteKey: async () => true,
    secretNames: async () => [],
    keyState: async () => 'none',
    mapLimit: async (items, _l, fn) => Promise.all(items.map(fn)),
  })
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

describe('web: memory and skill proposals are owner-only', () => {
  it('nobody without the owner token can read or change them', async () => {
    expect((await call('/api/manage/memory', null)).status).toBe(401)
    const invite = await call('/api/admin/invites', ownerToken, 'POST', { preset: 'collaborator' })
    const joined = await call('/api/join', null, 'POST', { invite: invite.body.token, name: 'Noor' })
    const guest = joined.body.accessToken as string
    for (const [p, m] of [['/api/manage/memory', 'GET'], ['/api/manage/skill-proposals', 'GET']] as const) expect((await call(p, guest, m)).status).toBe(403)
    expect((await call('/api/manage/memory', guest, 'PUT', { enabled: true })).status).toBe(403)
    expect(config.memory.enabled).toBe(false)
  })

  it('the owner edits both note files and the switches; secrets are refused with the file untouched', async () => {
    const got = await call('/api/manage/memory', ownerToken)
    expect(got.body).toMatchObject({ enabled: false, agentWrites: 'ask', maxTokens: 400 })
    const saved = await call('/api/manage/memory', ownerToken, 'PUT', { scope: 'project', notes: ['use pnpm', 'tests in spec/'], enabled: true, agentWrites: 'off', maxTokens: 300 })
    expect(saved.status).toBe(200)
    expect(saved.body.project.notes).toEqual(['use pnpm', 'tests in spec/'])
    expect(config.memory).toEqual({ enabled: true, agentWrites: 'off', maxTokens: 300 })
    const bad = await call('/api/manage/memory', ownerToken, 'PUT', { scope: 'project', notes: ['ok', 'password: hunter2hunter2'] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/secret/)
    expect((await call('/api/manage/memory', ownerToken)).body.project.notes).toEqual(['use pnpm', 'tests in spec/'])
    expect((await call('/api/manage/memory', ownerToken, 'PUT', { maxTokens: 99999 })).body.maxTokens).toBe(300)
  })

  it('the owner approves or rejects a proposal; nothing is installed before that', async () => {
    const a = await createProposal({ name: 'web-a', scope: 'project', description: 'when A', body: 'steps A', reason: 'r', cwd: work, sessionId: 'w1' })
    const b = await createProposal({ name: 'web-b', scope: 'project', description: 'when B', body: 'steps B', reason: 'r', cwd: work, sessionId: 'w2' })
    const list = await call('/api/manage/skill-proposals', ownerToken)
    expect(list.body.map((p: any) => p.name).sort()).toEqual(['web-a', 'web-b'])
    expect((await discoverSkills(work)).some((s) => s.name === 'web-a')).toBe(false)
    const ok = await call(`/api/manage/skill-proposals/${a.id}/approve`, ownerToken, 'POST', {})
    expect(ok.status).toBe(200)
    expect((await discoverSkills(work)).some((s) => s.name === 'web-a')).toBe(true)
    expect((await call(`/api/manage/skill-proposals/${b.id}`, ownerToken, 'DELETE')).status).toBe(200)
    expect((await discoverSkills(work)).some((s) => s.name === 'web-b')).toBe(false)
    expect((await call(`/api/manage/skill-proposals/${b.id}`, ownerToken, 'DELETE')).status).toBe(404)
    expect((await call('/api/manage/skill-proposals/..%2F..%2Fconfig/approve', ownerToken, 'POST', {})).status).toBe(400)
    for (const p of await listProposals()) await rejectProposal(p.id)
  })
})
