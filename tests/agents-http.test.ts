import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import type { AssistantTurn, Provider, ProviderEvent } from '../src/llm/provider.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { newOwnerToken, startServer, type RunningServer } from '../src/server/http.js'

/** First call asks to add an MCP server (an approval card); later calls just stop and wait. */
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

const cleanup: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of cleanup) await c()
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'vara-ag-'))
  const work = await mkdtemp(join(tmpdir(), 'vara-agw-'))
  let config: VaraConfig = { ...DEFAULT_CONFIG, mcp: { servers: {} } }
  const host = new VaraHost({ config: () => config, provider: () => new Asker(), hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: work, applyConfig: async (n) => void (config = n) })
  const token = newOwnerToken()
  const server: RunningServer = await startServer({ host, ownerToken: token, port: 0, limits: { failures: 10_000, joins: 10_000 } })
  cleanup.push(async () => {
    await host.closeAll()
    await server.close()
    await rm(dir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })
  const call = async (path: string, method = 'GET', json?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(json !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
    })
    return { status: res.status, body: (await res.json()) as any }
  }
  return { call, config: () => config }
}

describe('session routes the web UI depends on', () => {
  it('answering an approval card over HTTP uses the approval id from the URL', async () => {
    const { call, config } = await setup()
    const made = await call('/api/sessions', 'POST', { message: 'please set up docs lookup for this project', kind: 'task' })
    expect(made.status).toBe(200)
    const id = made.body.id as string
    let approval: { id: string } | undefined
    for (let i = 0; i < 300 && !approval; i++) {
      approval = (await call(`/api/sessions/${id}`)).body.pendingApprovals?.[0]
      if (!approval) await new Promise((r) => setTimeout(r, 25))
    }
    expect(approval).toBeDefined()
    expect((await call(`/api/sessions/${id}/approvals/nope`, 'POST', { approved: true })).status).toBe(404)
    expect(config().mcp.servers['docs']).toBeUndefined()
    const ok = await call(`/api/sessions/${id}/approvals/${approval!.id}`, 'POST', { approved: true })
    expect(ok.status).toBe(200)
    for (let i = 0; i < 300 && !config().mcp.servers['docs']; i++) await new Promise((r) => setTimeout(r, 25))
    expect(config().mcp.servers['docs']).toBeDefined()
  })

  it('cancelling agents answers {cancelled:false} when none run, and 404 for an unknown session', async () => {
    const { call } = await setup()
    const made = await call('/api/sessions', 'POST', { message: 'hello there', kind: 'task' })
    const id = made.body.id as string
    const all = await call(`/api/sessions/${id}/agents/cancel`, 'POST', {})
    expect(all.status).toBe(200)
    expect(all.body).toEqual({ cancelled: false })
    const one = await call(`/api/sessions/${id}/agents/cancel`, 'POST', { id: 'scan' })
    expect(one.body).toEqual({ cancelled: false })
    expect((await call('/api/sessions/zzzzzzzz/agents/cancel', 'POST', {})).status).toBe(404)
  })
})
