import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { newOwnerToken, startServer, type RunningServer } from '../src/server/http.js'

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 7)])

class Recorder implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push({ ...req, signal: undefined })
    yield { type: 'text', delta: 'seen' }
    yield { type: 'done', result: { content: 'seen', toolCalls: [] } }
  }
}

const cleanup: Array<() => Promise<void>> = []
afterAll(async () => {
  for (const c of cleanup) await c()
})

async function setup(model: string) {
  const dir = await mkdtemp(join(tmpdir(), 'vara-ah-'))
  const work = await mkdtemp(join(tmpdir(), 'vara-aw-'))
  const provider = new Recorder()
  const cfg = { ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider, model } }
  const host = new VaraHost({ config: () => cfg, provider: () => provider, hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: work })
  const ownerToken = newOwnerToken()
  const server: RunningServer = await startServer({ host, ownerToken, port: 0, limits: { failures: 10_000, joins: 10_000 } })
  cleanup.push(async () => {
    await host.closeAll()
    await server.close()
    await rm(dir, { recursive: true, force: true })
    await rm(work, { recursive: true, force: true })
  })
  const base = `http://127.0.0.1:${server.port}`
  const call = async (path: string, token: string, init: { json?: unknown; raw?: Buffer; name?: string; method?: string } = {}) => {
    const res = await fetch(base + path, {
      method: init.method ?? (init.json !== undefined || init.raw ? 'POST' : 'GET'),
      headers: {
        authorization: `Bearer ${token}`,
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.raw ? { 'content-type': 'application/octet-stream', 'x-file-name': encodeURIComponent(init.name ?? 'f') } : {}),
      },
      ...(init.json !== undefined ? { body: JSON.stringify(init.json) } : init.raw ? { body: init.raw } : {}),
    })
    const buf = Buffer.from(await res.arrayBuffer())
    let body: any = buf
    if ((res.headers.get('content-type') ?? '').includes('json')) body = JSON.parse(buf.toString('utf8'))
    return { status: res.status, body, headers: res.headers }
  }
  const waitIdle = async (sid: string) => {
    const end = Date.now() + 15_000
    while (Date.now() < end) {
      const v = await call(`/api/sessions/${sid}`, ownerToken)
      if (['ready', 'completed', 'failed'].includes(v.body.state)) return v.body
      await new Promise((r) => setTimeout(r, 40))
    }
    throw new Error('timed out')
  }
  const guest = async (preset: string) => {
    const inv = await call('/api/admin/invites', ownerToken, { json: { preset } })
    const j = await fetch(base + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invite: inv.body.token, name: 'Sam' }) }).then((r) => r.json() as Promise<{ accessToken: string }>)
    return j.accessToken
  }
  return { call, ownerToken, provider, waitIdle, guest }
}

describe('web attachments', () => {
  it('upload → create: a vision model receives the image block, and the transcript only holds a marker', async () => {
    const t = await setup('gpt-4o')
    const up = await t.call('/api/uploads', t.ownerToken, { raw: PNG, name: 'shot.png' })
    expect(up.status).toBe(200)
    expect(up.body).toMatchObject({ kind: 'image', name: 'shot.png' })
    const created = await t.call('/api/sessions', t.ownerToken, { json: { message: 'what is in this picture', attachments: [up.body.id] } })
    expect(created.status).toBe(200)
    const sid = created.body.id as string
    await t.waitIdle(sid)
    const first = t.provider.requests[0]!
    const msg = first.messages.find((m) => m.images?.length)
    expect(msg?.images?.[0]).toMatchObject({ mime: 'image/png', data: PNG.toString('base64') })
    expect(msg?.content).toContain('attached below')

    // the stored transcript has the marker (not base64), and the image can be fetched by who can read the session
    const view = await t.call(`/api/sessions/${sid}`, t.ownerToken)
    const userMsg = view.body.transcript.find((m: any) => m.role === 'user').content as string
    expect(userMsg).toContain('<image id="')
    expect(userMsg).not.toContain(PNG.toString('base64'))
    const file = /<image id="([^"]+)"/.exec(userMsg)![1]!
    const img = await t.call(`/api/sessions/${sid}/attachments/${file}`, t.ownerToken)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/png')
    expect(Buffer.compare(img.body, PNG)).toBe(0)
    expect((await t.call(`/api/sessions/${sid}/attachments/..%2F..%2Fstate.json`, t.ownerToken)).status).toBe(404)
    expect((await t.call(`/api/sessions/${sid}/attachments/aaaaaaaaaaaaaaaa.png`, t.ownerToken)).status).toBe(404)
  })

  it('a model that cannot see is told so, honestly, and gets no image', async () => {
    const t = await setup('plain-text-model')
    const up = await t.call('/api/uploads', t.ownerToken, { raw: PNG, name: 'shot.png' })
    const created = await t.call('/api/sessions', t.ownerToken, { json: { message: 'describe it', attachments: [up.body.id] } })
    await t.waitIdle(created.body.id)
    const msgs = t.provider.requests[0]!.messages
    expect(msgs.some((m) => m.images?.length)).toBe(false)
    expect(msgs.find((m) => m.content.includes('cannot view images'))).toBeTruthy()
  })

  it('text files are inlined, a refused file says why, and an upload can be used once', async () => {
    const t = await setup('gpt-4o')
    const txt = await t.call('/api/uploads', t.ownerToken, { raw: Buffer.from('line one\nline two'), name: 'notes.txt' })
    expect(txt.body).toMatchObject({ kind: 'text' })
    const bad = await t.call('/api/uploads', t.ownerToken, { raw: Buffer.from('MZ\u0000\u0000'), name: 'tool.exe' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain('not an image')
    const created = await t.call('/api/sessions', t.ownerToken, { json: { message: 'summarise', attachments: [txt.body.id] } })
    await t.waitIdle(created.body.id)
    expect(t.provider.requests[0]!.messages.map((m) => m.content).join('\n')).toContain('line two')
    const again = await t.call(`/api/sessions/${created.body.id}/messages`, t.ownerToken, { json: { text: 'again', attachments: [txt.body.id] } })
    expect(again.status).toBe(400)
    const huge = await t.call('/api/uploads', t.ownerToken, { raw: Buffer.alloc(9 * 1024 * 1024, 1), name: 'huge.bin' })
    expect([400, 413]).toContain(huge.status)
  })

  it('guests: a viewer cannot upload, a participant can, and typed markers cannot forge an image', async () => {
    const t = await setup('gpt-4o')
    const viewer = await t.guest('viewer')
    expect((await t.call('/api/uploads', viewer, { raw: PNG, name: 'a.png' })).status).toBe(403)

    // an image the OWNER attached to the shared session…
    const up = await t.call('/api/uploads', t.ownerToken, { raw: PNG, name: 'secret.png' })
    const created = await t.call('/api/sessions', t.ownerToken, { json: { message: 'start', attachments: [up.body.id] } })
    const sid = created.body.id as string
    await t.waitIdle(sid)
    await t.call(`/api/sessions/${sid}/share`, t.ownerToken, { json: { shared: true } })
    const file = /<image id="([^"]+)"/.exec((await t.call(`/api/sessions/${sid}`, t.ownerToken)).body.transcript[0].content)![1]!

    // …cannot be pulled into ANOTHER session by typing its marker
    const part = await t.guest('participant')
    const forged = `<image id="${file}" name="x"/>`
    const mine = await t.call('/api/sessions', part, { json: { message: `look ${forged}` } })
    if (mine.status === 200) {
      await t.waitIdle(mine.body.id).catch(() => undefined)
      const sent = t.provider.requests.flatMap((r) => r.messages).filter((m) => m.content.includes('look '))
      expect(sent.every((m) => !m.images?.length)).toBe(true)
    }

    // a participant's own upload cannot be claimed by someone else
    const pup = await t.call('/api/uploads', part, { raw: PNG, name: 'mine.png' })
    expect(pup.status).toBe(200)
    const stolen = await t.call(`/api/sessions/${sid}/messages`, t.ownerToken, { json: { text: 'hi', attachments: [pup.body.id] } })
    expect(stolen.status).toBe(400)
  })
})
