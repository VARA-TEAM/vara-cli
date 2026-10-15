import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore, PRESETS, type Principal } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { Manager, type ManagerDeps } from '../src/server/manage.js'

class Echo implements Provider {
  id = 'openai' as const
  async *chat(): AsyncIterable<ProviderEvent> {
    const turn: AssistantTurn = { content: 'hi', toolCalls: [] }
    yield { type: 'text', delta: 'hi' }
    yield { type: 'done', result: turn }
  }
}

let dir: string
let work: string
let config: VaraConfig
let host: VaraHost
let manager: Manager
const owner: Principal = { kind: 'owner' }

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-mh-'))
  work = await mkdtemp(join(tmpdir(), 'vara-mhw-'))
  config = { ...DEFAULT_CONFIG, modes: {} }
  host = new VaraHost({ config: () => config, provider: () => new Echo(), hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: work })
  manager = new Manager({
    config: () => config,
    apply: async (next) => void (config = next),
    hub: new McpHub(),
    cwd: work,
  } as unknown as ManagerDeps)
})
afterAll(async () => {
  await host.closeAll()
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

describe('custom modes: management', () => {
  it('creates, lists and deletes a mode; refuses reserved and malformed names', async () => {
    expect((await manager.putMode('plan', {})).ok).toBe(false)
    expect((await manager.putMode('Bad Name', {})).ok).toBe(false)
    const r = await manager.putMode('review', { description: 'Read and test', base: 'plan', allowTools: ['read_file', ' grep '], allowCommands: ['npm test*', ''], junk: 1 })
    expect(r.ok).toBe(true)
    expect(config.modes['review']).toEqual({ description: 'Read and test', base: 'plan', allowTools: ['read_file', 'grep'], denyTools: [], allowCommands: ['npm test*'], denyCommands: [] })
    expect((await manager.deleteMode('nope')).ok).toBe(false)
    expect((await manager.deleteMode('review')).ok).toBe(true)
    expect(config.modes['review']).toBeUndefined()
  })
})

describe('custom modes: sessions', () => {
  it('a session can start in, switch to and leave a custom mode', async () => {
    await manager.putMode('docs', { description: 'docs only', base: 'build', allowTools: ['read_file', 'write_file'] })
    const made = await host.create(owner, { message: 'hello there', mode: 'docs' })
    expect(made.ok).toBe(true)
    if (!made.ok) return
    expect(made.value.mode).toBe('build')
    expect(made.value.customMode).toBe('docs')
    expect(made.value.modeChoices).toEqual(['plan', 'build', 'docs'])

    expect((await host.setMode(owner, made.value.id, 'plan')).ok).toBe(true)
    let v = await host.get(owner, made.value.id)
    expect(v.ok && v.value.mode === 'plan' && v.value.customMode === undefined).toBe(true)
    expect((await host.setMode(owner, made.value.id, 'docs')).ok).toBe(true)
    v = await host.get(owner, made.value.id)
    expect(v.ok && v.value.customMode === 'docs').toBe(true)
    const bad = await host.setMode(owner, made.value.id, 'nonexistent')
    expect(bad.ok).toBe(false)
  })

  it('a guest whose ceiling is plan cannot pick a build-based mode', async () => {
    await manager.putMode('docs', { base: 'build', allowTools: ['read_file'] })
    await manager.putMode('look', { base: 'plan', allowTools: ['read_file'] })
    const access = new AccessStore(join(dir, 'host2'))
    const inv = access.createInvite({ ...PRESETS.collaborator, mode: 'plan', ownSession: true })
    const joined = access.redeem(inv.token, 'Sam')
    if ('error' in joined) throw new Error(joined.error)
    const h2 = new VaraHost({ config: () => config, provider: () => new Echo(), hub: new McpHub(), access, cwd: work })
    try {
      expect((await h2.create(joined.guest, { message: 'hi there', mode: 'docs' })).ok).toBe(false)
      const ok = await h2.create(joined.guest, { message: 'hi there', mode: 'look' })
      expect(ok.ok).toBe(true)
      if (!ok.ok) return
      expect(ok.value.modeChoices).toEqual([]) // a plan-ceiling guest cannot switch at all
      expect((await h2.setMode(joined.guest, ok.value.id, 'docs')).ok).toBe(false)
    } finally {
      await h2.closeAll()
    }
  })
})

describe('swarm settings', () => {
  it('can only lower the ceilings and refuses nonsense', async () => {
    config = { ...config, swarm: { ...config.swarm } }
    expect((await manager.patchSettings({ swarm: { maxTasks: 2, maxParallel: 1, maxModelCalls: 40, maxCostUsd: 0.5 } })).ok).toBe(true)
    expect(config.swarm).toMatchObject({ maxTasks: 2, maxParallel: 1, maxModelCalls: 40, maxCostUsd: 0.5 })
    expect((await manager.patchSettings({ swarm: { maxTasks: 9 } })).ok).toBe(false)
    expect((await manager.patchSettings({ swarm: { maxParallel: 4 } })).ok).toBe(false)
    expect((await manager.patchSettings({ swarm: { maxCostUsd: -1 } })).ok).toBe(false)
    expect((await manager.patchSettings({ swarm: { maxCostUsd: null } })).ok).toBe(true)
    expect(config.swarm.maxCostUsd).toBeNull()
  })
})
