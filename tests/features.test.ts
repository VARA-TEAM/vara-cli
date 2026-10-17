import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderEvent } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { newOwnerToken, startServer, type RunningServer } from '../src/server/http.js'
import { disabledFeatures, featureMap } from '../src/server/features.js'

class Quiet implements Provider {
  id = 'openai' as const
  // eslint-disable-next-line require-yield
  async *chat(): AsyncIterable<ProviderEvent> {
    yield { type: 'done', result: { content: 'ok', toolCalls: [] } }
  }
}

describe('turning features off for a whole host (VARA_DISABLE)', () => {
  it('reads a comma list, ignores unknown names and case', () => {
    expect([...disabledFeatures({ VARA_DISABLE: ' Team, gateways ,nonsense,' })].sort()).toEqual(['gateways', 'team'])
    expect(disabledFeatures({}).size).toBe(0)
    expect(featureMap(new Set(['team']))).toEqual({ team: false, gateways: true, tunnel: true, desktop: true, browser: true })
  })

  describe('on a running host', () => {
    let dir: string
    let work: string
    let server: RunningServer
    let host: VaraHost
    const ownerToken = newOwnerToken()
    let base = ''

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'vara-feat-'))
      work = await mkdtemp(join(tmpdir(), 'vara-featw-'))
      host = new VaraHost({ config: () => DEFAULT_CONFIG, provider: () => new Quiet(), hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: work })
      server = await startServer({ host, ownerToken, port: 0, disabled: new Set(['team', 'gateways']) })
      base = `http://127.0.0.1:${server.port}`
    })
    afterAll(async () => {
      await host.closeAll()
      await server.close()
      await rm(dir, { recursive: true, force: true })
      await rm(work, { recursive: true, force: true })
    })

    const call = async (path: string, init: RequestInit = {}, token: string | null = ownerToken) => {
      const res = await fetch(base + path, { ...init, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) } })
      const text = await res.text()
      return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} }
    }

    it('tells the web interface which features are off', async () => {
      const me = await call('/api/me')
      expect(me.status).toBe(200)
      expect(me.body['features']).toEqual({ team: false, gateways: false, tunnel: true, desktop: true, browser: true })
    })

    it('refuses everything that belongs to Team: invites, guests, the overview, redeeming an invite and sharing a session', async () => {
      for (const [path, init] of [
        ['/api/admin/overview', {}],
        ['/api/admin/invites', {}],
        ['/api/admin/invites', { method: 'POST', body: JSON.stringify({ preset: 'viewer' }) }],
        ['/api/admin/guests', {}],
      ] as Array<[string, RequestInit]>) {
        const r = await call(path, init)
        expect(r.status, path).toBe(403)
        expect(String(r.body['error'])).toMatch(/turned off/)
      }
      const join = await call('/api/join', { method: 'POST', body: JSON.stringify({ invite: 'whatever', name: 'x' }) }, null)
      expect(join.status).toBe(403)
      const created = await call('/api/sessions', { method: 'POST', body: JSON.stringify({ message: 'hi' }) })
      const id = (created.body['id'] ?? (created.body['session'] as { id?: string } | undefined)?.id) as string
      expect(id).toBeTruthy()
      const share = await call(`/api/sessions/${id}/share`, { method: 'POST', body: JSON.stringify({ shared: true }) })
      expect(share.status).toBe(403)
    })

    it('refuses the messaging gateways, and still serves everything else', async () => {
      expect((await call('/api/manage/gateways')).status).toBe(403)
      expect((await call('/api/sessions')).status).toBe(200)
      expect((await call('/api/health', {}, null)).status).toBe(200)
    })
  })

  it('a host with nothing turned off still offers Team', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-feat2-'))
    const work = await mkdtemp(join(tmpdir(), 'vara-feat2w-'))
    const host = new VaraHost({ config: () => DEFAULT_CONFIG, provider: () => new Quiet(), hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: work })
    const token = newOwnerToken()
    const server = await startServer({ host, ownerToken: token, port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${server.port}/api/admin/guests`, { headers: { authorization: `Bearer ${token}` } })
      expect(res.status).toBe(200)
    } finally {
      await host.closeAll()
      await server.close()
      await rm(dir, { recursive: true, force: true })
      await rm(work, { recursive: true, force: true })
    }
  })
})
