import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore, PRESETS, type Principal } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'

/** First call asks to add an MCP server; later calls just answer. */
class Asker implements Provider {
  id = 'openai' as const
  n = 0
  async *chat(): AsyncIterable<ProviderEvent> {
    const turn: AssistantTurn =
      this.n++ === 0
        ? { content: '', toolCalls: [{ id: 'm1', name: 'mcp_manage', arguments: JSON.stringify({ action: 'add', name: 'docs', command: 'npx -y @scope/docs' }) }] }
        : { content: 'done', toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify({ question: 'anything else, please?' }) }] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

let dir: string
let work: string
let config: VaraConfig
const owner: Principal = { kind: 'owner' }
const wait = async (fn: () => Promise<boolean>, ms = 8000): Promise<void> => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out')
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-ap-'))
  work = await mkdtemp(join(tmpdir(), 'vara-apw-'))
  config = { ...DEFAULT_CONFIG, mcp: { servers: {} } }
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const mkHost = (access: AccessStore): VaraHost =>
  new VaraHost({ config: () => config, provider: () => new Asker(), hub: new McpHub(), access, cwd: work, applyConfig: async (n) => void (config = n) })

describe('approval cards in the host', () => {
  it('the owner sees the pending request, approves it, and only then is the config changed', async () => {
    const host = mkHost(new AccessStore(join(dir, 'a')))
    try {
      const made = await host.create(owner, { message: 'please set up docs lookup for this project', kind: 'task' })
      if (!made.ok) throw new Error(made.error)
      const id = made.value.id
      let req: { id: string; action: string; detail: string } | undefined
      await wait(async () => {
        const v = await host.get(owner, id)
        req = v.ok ? v.value.pendingApprovals[0] : undefined
        return !!req
      })
      expect(req!.action).toBe('mcp_add')
      expect(req!.detail).toMatch(/npx -y @scope\/docs/)
      expect(config.mcp.servers['docs']).toBeUndefined() // nothing happened yet
      expect((await host.resolveApproval(owner, id, 'nope', true)).ok).toBe(false)
      expect((await host.resolveApproval(owner, id, req!.id, true)).ok).toBe(true)
      await wait(async () => !!config.mcp.servers['docs'])
      const v = await host.get(owner, id)
      expect(v.ok && v.value.pendingApprovals).toEqual([])
    } finally {
      await host.closeAll()
    }
  })

  it('a guest cannot answer approvals, and a guest agent cannot manage itself at all', async () => {
    config = { ...DEFAULT_CONFIG, mcp: { servers: {} } }
    const access = new AccessStore(join(dir, 'b'))
    const inv = access.createInvite({ ...PRESETS.collaborator, mode: 'build', ownSession: true })
    const joined = access.redeem(inv.token, 'Sam')
    if ('error' in joined) throw new Error(joined.error)
    const host = mkHost(access)
    try {
      const made = await host.create(joined.guest, { message: 'please set up docs lookup for this project', kind: 'task' })
      if (!made.ok) throw new Error(made.error)
      await wait(async () => {
        const v = await host.get(joined.guest, made.value.id)
        return v.ok && v.value.state !== 'running' && v.value.state !== 'idle'
      })
      expect(config.mcp.servers['docs']).toBeUndefined()
      expect((await host.resolveApproval(joined.guest, made.value.id, 'x', true)).ok).toBe(false)
    } finally {
      await host.closeAll()
    }
  })
})
