import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PreviewManager } from '../src/preview/manager.js'
import { makePreviewTool } from '../src/tools/preview-tool.js'
import type { ToolContext } from '../src/tools/types.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { newOwnerToken, startServer } from '../src/server/http.js'
import { previews } from '../src/preview/manager.js'
import type { Provider, ProviderEvent } from '../src/llm/provider.js'

let dir: string
let serverJs: string
const SERVER = `
const http = require('node:http')
const s = http.createServer((req, res) => {
  if (req.url === '/host') return res.end(req.headers.host + '|' + (req.headers.origin ?? ''))
  res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY', 'content-security-policy': "default-src 'self'; frame-ancestors 'none'" })
  res.end('<h1>hello preview</h1>')
})
s.on('upgrade', (req, socket) => {
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\n\\r\\n')
  socket.on('data', (d) => socket.write('echo:' + d))
})
s.listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready on http://localhost:' + process.env.PORT))
`

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-prev-'))
  serverJs = join(dir, 'server.js')
  await writeFile(serverJs, SERVER)
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true }).catch(() => undefined)
})

const get = (url: string, headers: Record<string, string> = {}) =>
  new Promise<{ status: number; headers: Record<string, any>; body: string }>((resolve, reject) => {
    const u = new URL(url)
    const r = request({ host: u.hostname, port: u.port, path: u.pathname, headers }, (res) => {
      let body = ''
      res.on('data', (c) => (body += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
    })
    r.on('error', reject)
    r.end()
  })

describe('PreviewManager', () => {
  it('starts a dev server, fronts it with a loopback proxy and stops it for good', async () => {
    const m = new PreviewManager()
    m.setFrameAncestors(['http://127.0.0.1:4000'])
    const info = await m.start('s1', { command: `node "${serverJs}"`, cwd: dir })
    expect(info.state).toBe('running')
    expect(info.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/)
    expect(info.port).toBeGreaterThan(1023)

    const page = await get(info.url!)
    expect(page.status).toBe(200)
    expect(page.body).toContain('hello preview')
    // framing is limited to VARA's own page: the app's own deny headers are replaced
    expect(page.headers['x-frame-options']).toBeUndefined()
    const csp = ([] as string[]).concat(page.headers['content-security-policy']).join(' | ')
    expect(csp).not.toContain("frame-ancestors 'none'")
    expect(csp).toContain('frame-ancestors http://127.0.0.1:4000')

    // the dev server sees its own host, not the proxy's
    const seen = await get(new URL('/host', info.url).href, { origin: info.url!.replace(/\/$/, '') })
    expect(seen.body).toBe(`127.0.0.1:${info.port}|http://127.0.0.1:${info.port}`)

    // a DNS-rebinding page arrives with a foreign Host
    const proxyPort = new URL(info.url!).port
    expect((await get(info.url!, { host: `evil.example:${proxyPort}` })).status).toBe(421)

    expect(m.logs('s1')).toContain('ready on')
    await m.stop('s1')
    expect(m.get('s1')).toBeNull()
    await expect(get(info.url!)).rejects.toThrow()
    // The dev server is a child process: how long it takes to die depends on how busy the machine is, so wait for
    // it (up to 10 s) instead of guessing 600 ms.
    const gone = async (): Promise<boolean> => get(`http://127.0.0.1:${info.port}/`).then(() => false, () => true)
    for (let i = 0; i < 100 && !(await gone()); i++) await new Promise((r) => setTimeout(r, 100))
    await expect(get(`http://127.0.0.1:${info.port}/`)).rejects.toThrow()
  })

  it('relays websocket upgrades (hot reload)', async () => {
    const m = new PreviewManager()
    const info = await m.start('ws', { command: `node "${serverJs}"`, cwd: dir })
    const port = Number(new URL(info.url!).port)
    const got = await new Promise<string>((resolve, reject) => {
      const s = connect(port, '127.0.0.1', () => s.write(`GET /hmr HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n`))
      let buf = ''
      s.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('101') && !buf.includes('echo:')) s.write('ping')
        if (buf.includes('echo:ping')) (s.destroy(), resolve(buf))
      })
      s.on('error', reject)
      setTimeout(() => reject(new Error('no echo')), 5000)
    })
    expect(got).toContain('101')
    await m.stop('ws')
  })

  it('reports a command that dies and a server that never listens, with a useful reason', async () => {
    const m = new PreviewManager({ startTimeoutMs: 2000, pollMs: 100 })
    const died = await m.start('d', { command: 'node -e "console.log(\'boom\'); process.exit(3)"', cwd: dir })
    expect(died.state).toBe('failed')
    expect(died.error).toContain('exited')
    expect(m.logs('d')).toContain('boom')
    const idle = await m.start('i', { command: 'node -e "setTimeout(()=>{},8000)"', cwd: dir })
    expect(idle.state).toBe('failed')
    expect(idle.error).toContain('PORT')
    await m.stopAll()
  }, 15_000)

  it('caps concurrent previews and replaces the one of the same session', async () => {
    const m = new PreviewManager()
    const run = (id: string) => m.start(id, { command: `node "${serverJs}"`, cwd: dir })
    await run('a')
    await run('b')
    await run('c')
    await expect(run('d')).rejects.toThrow(/at most 3/)
    const again = await run('a')
    expect(again.state).toBe('running')
    await m.stopAll()
  }, 20_000)
})

describe('preview tool', () => {
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ cwd: dir, mode: 'build', sessionId: 'tool-s', scope: 'session:tool-s', env: { ...process.env } as Record<string, string>, allowPublish: false, ...over })

  it('starts, reads logs, and stops; refuses publishing commands and escaping cwd', async () => {
    const m = new PreviewManager()
    const tool = makePreviewTool(m)
    const r = await tool.execute({ action: 'start', command: `node "${serverJs}"` }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toMatch(/preview running at http:\/\/127\.0\.0\.1:\d+\//)
    expect((await tool.execute({ action: 'logs' }, ctx())).output).toContain('ready on')
    expect((await tool.execute({ action: 'status' }, ctx())).output).toMatch(/^running/)
    expect((await tool.execute({ action: 'stop' }, ctx())).ok).toBe(true)
    expect((await tool.execute({ action: 'status' }, ctx())).output).toContain('no preview')

    const push = await tool.execute({ action: 'start', command: 'git push origin main' }, ctx())
    expect(push.ok).toBe(false)
    expect(await tool.guard!({ action: 'start', command: 'git push origin main' }, ctx())).toBeTruthy()
    expect((await tool.execute({ action: 'start', command: 'node x.js', cwd: '..' }, ctx())).output).toContain('escapes')
    expect((await tool.execute({ action: 'start' }, ctx())).ok).toBe(false)
    expect(tool.readonly).toBe(false)
  })
})

describe('preview over the host API', () => {
  class Idle implements Provider {
    id = 'openai' as const
    async *chat(): AsyncIterable<ProviderEvent> {
      yield { type: 'done', result: { content: 'ok', toolCalls: [] } }
    }
  }

  it('is owner-only; start → state → stop; the host CSP lets the page frame loopback previews', async () => {
    const work = await mkdtemp(join(tmpdir(), 'vara-pw-'))
    await writeFile(join(work, 'server.js'), SERVER)
    const host = new VaraHost({ config: () => DEFAULT_CONFIG, provider: () => new Idle(), hub: new McpHub(), access: new AccessStore(join(work, 'host')), cwd: work })
    const ownerToken = newOwnerToken()
    const server = await startServer({ host, ownerToken, port: 0, limits: { failures: 1000, joins: 1000 } })
    const base = `http://127.0.0.1:${server.port}`
    const call = async (path: string, token: string, method = 'GET', json?: unknown) => {
      const res = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, ...(json ? { 'content-type': 'application/json' } : {}) }, ...(json ? { body: JSON.stringify(json) } : {}) })
      return { status: res.status, body: (await res.json().catch(() => ({}))) as any, csp: res.headers.get('content-security-policy') }
    }
    try {
      const created = await call('/api/sessions', ownerToken, 'POST', { message: 'hello there' })
      const sid = created.body.id as string
      expect(created.csp).toContain('frame-src http://127.0.0.1:*')

      const started = await call(`/api/sessions/${sid}/preview`, ownerToken, 'POST', { command: 'node server.js' })
      expect(started.status).toBe(200)
      expect(started.body.preview.state).toBe('running')
      const page = await get(started.body.preview.url)
      // the proxy admits framing by the host's own page only
      expect(([] as string[]).concat(page.headers['content-security-policy']).join(' ')).toContain(`frame-ancestors http://127.0.0.1:${server.port}`)

      const state = await call(`/api/sessions/${sid}/preview`, ownerToken)
      expect(state.body.preview.url).toBe(started.body.preview.url)
      expect(state.body.logs).toContain('ready on')

      // a guest can neither see nor start one
      const inv = await call('/api/admin/invites', ownerToken, 'POST', { preset: 'collaborator' })
      const join = await fetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: inv.body.token, name: 'G' }) }).then((r) => r.json() as Promise<any>)
      expect((await call(`/api/sessions/${sid}/preview`, join.accessToken)).status).toBe(404)
      expect((await call(`/api/sessions/${sid}/preview`, join.accessToken, 'POST', { command: 'node server.js' })).status).toBe(404)

      expect((await call(`/api/sessions/${sid}/preview`, ownerToken, 'DELETE')).status).toBe(200)
      expect((await call(`/api/sessions/${sid}/preview`, ownerToken)).body.preview).toBeNull()
      expect((await call(`/api/sessions/${sid}/preview`, ownerToken, 'POST', { command: '  ' })).status).toBe(400)
    } finally {
      await previews.stopAll()
      await host.closeAll()
      await server.close()
      await rm(work, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 30_000)
})
