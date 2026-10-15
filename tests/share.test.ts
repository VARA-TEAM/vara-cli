import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import type { Provider, ProviderEvent } from '../src/llm/provider.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore, PRESETS } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { newOwnerToken, startServer } from '../src/server/http.js'
import { Sharing } from '../src/server/share.js'
import { PROVIDERS, availableProviders, openTunnel, pickProvider, type TunnelDeps } from '../src/server/tunnel.js'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('close', 0))
    return true
  }
  say(text: string, stream: 'stdout' | 'stderr' = 'stderr'): void {
    this[stream].write(text + '\n')
  }
  die(code = 1): void {
    this.emit('close', code)
  }
}

function fakeDeps(script: (child: FakeChild, bin: string, args: string[]) => void, installed = ['cloudflared', 'ssh']): TunnelDeps & { children: FakeChild[]; calls: Array<{ bin: string; args: string[] }> } {
  const children: FakeChild[] = []
  const calls: Array<{ bin: string; args: string[] }> = []
  return {
    children,
    calls,
    has: async (b) => installed.includes(b),
    timeoutMs: 400,
    spawn: ((bin: string, args: string[]) => {
      const c = new FakeChild()
      children.push(c)
      calls.push({ bin, args })
      setTimeout(() => script(c, bin, args), 5)
      return c
    }) as never,
  }
}

describe('tunnel providers', () => {
  it('cloudflared: reads the trycloudflare URL out of its log and tears it down', async () => {
    const deps = fakeDeps((c) => {
      c.say('2026-10-15 INF Thank you for trying Cloudflare Tunnel.')
      c.say('INF |  https://quiet-river-1234.trycloudflare.com                |')
    })
    const t = await openTunnel(7777, PROVIDERS[0]!, {}, deps)
    expect(t.url).toBe('https://quiet-river-1234.trycloudflare.com')
    expect(t.host).toBe('quiet-river-1234.trycloudflare.com')
    expect(deps.calls[0]).toEqual({ bin: 'cloudflared', args: ['tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:7777'] })
    await t.close()
    expect(deps.children[0]!.killed).toBe(true)
    expect(await t.ended).toBeTypeOf('string')
  })

  it('ssh: forwards only the host port to the relay and skips the relay\'s own docs links', async () => {
    const deps = fakeDeps((c) => {
      c.say('Connect to https://admin.localhost.run/ or https://localhost.run/docs for a custom domain', 'stdout')
      c.say('a1b2c3d4e5f6a7.lhr.life tunneled with tls termination, https://a1b2c3d4e5f6a7.lhr.life', 'stdout')
    })
    const t = await openTunnel(8123, PROVIDERS[1]!, { sshHost: 'localhost.run' }, deps)
    expect(t.url).toBe('https://a1b2c3d4e5f6a7.lhr.life')
    expect(deps.calls[0]!.bin).toBe('ssh')
    expect(deps.calls[0]!.args).toContain('80:127.0.0.1:8123')
    expect(deps.calls[0]!.args).toContain('nokey@localhost.run')
    await t.close()
  })

  it('a tunnel that dies or stays silent is an error that says what the tool printed (scrubbed)', async () => {
    const died = fakeDeps((c) => {
      c.say('failed to connect: permission denied')
      c.die(255)
    })
    await expect(openTunnel(1, PROVIDERS[1]!, {}, died)).rejects.toThrow(/permission denied/)
    const silent = fakeDeps((c) => c.say('connecting…'))
    await expect(openTunnel(1, PROVIDERS[0]!, {}, silent)).rejects.toThrow(/did not give a public address.*connecting/)
    expect(silent.children[0]!.killed).toBe(true)
  })

  it('chooses an installed tool and explains what to install when there is none', async () => {
    const only = fakeDeps(() => undefined, ['ssh'])
    expect((await pickProvider('auto', only)).id).toBe('ssh')
    expect((await availableProviders(fakeDeps(() => undefined, ['cloudflared', 'ssh']))).map((p) => p.id)).toEqual(['cloudflared', 'ssh'])
    await expect(pickProvider('cloudflared', only)).rejects.toThrow(/not installed.*cloudflared/s)
    await expect(pickProvider('nope', only)).rejects.toThrow(/unknown tunnel/)
    await expect(pickProvider('auto', fakeDeps(() => undefined, []))).rejects.toThrow(/Install one of.*cloudflared.*ssh/s)
  })
})

describe('Sharing life cycle', () => {
  afterEach(() => vi.useRealTimers())

  const wiring = () => {
    const w = { allowedHosts: ['kept.example'], publicHosts: [] as string[], bases: [] as Array<string | undefined>, ended: [] as string[] }
    return w
  }
  const url = (c: FakeChild) => c.say('https://abc-def.trycloudflare.com')

  it('start wires the host in and the guest address out; stop undoes every bit of it', async () => {
    const w = wiring()
    const deps = fakeDeps(url)
    const s = new Sharing({ port: 1, allowedHosts: w.allowedHosts, publicHosts: w.publicHosts, setGuestBase: (u) => w.bases.push(u), onEnd: (r) => w.ended.push(r), deps })
    const info = await s.start('auto', { minutes: 30 })
    expect(info.url).toBe('https://abc-def.trycloudflare.com')
    expect(info.expiresAt).toBeTruthy()
    expect(w.allowedHosts).toEqual(['kept.example', 'abc-def.trycloudflare.com'])
    expect(w.publicHosts).toEqual(['abc-def.trycloudflare.com'])
    expect(w.bases).toEqual(['https://abc-def.trycloudflare.com'])
    await expect(s.start('auto')).rejects.toThrow(/already open/)

    await s.stop()
    expect(w.allowedHosts).toEqual(['kept.example'])
    expect(w.publicHosts).toEqual([])
    expect(w.bases.at(-1)).toBeUndefined()
    expect(deps.children[0]!.killed).toBe(true)
    expect(s.current()).toBeUndefined()
    expect(w.ended).toEqual([]) // an owner's stop is not an "ended" surprise
    await s.stop() // idempotent
  })

  it('closes itself when the time is up', async () => {
    vi.useFakeTimers()
    const w = wiring()
    const s = new Sharing({ port: 1, allowedHosts: w.allowedHosts, publicHosts: w.publicHosts, setGuestBase: (u) => w.bases.push(u), onEnd: (r) => w.ended.push(r), deps: { ...fakeDeps(url), timeoutMs: 60_000 } })
    const p = s.start('auto', { minutes: 5 })
    await vi.advanceTimersByTimeAsync(10)
    await p
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10)
    expect(w.ended[0]).toContain('5-minute public link expired')
    expect(w.publicHosts).toEqual([])
    expect(s.current()).toBeUndefined()
  })

  it('closes itself and says so when the tunnel process dies', async () => {
    const w = wiring()
    const deps = fakeDeps(url)
    const s = new Sharing({ port: 1, allowedHosts: w.allowedHosts, publicHosts: w.publicHosts, setGuestBase: (u) => w.bases.push(u), onEnd: (r) => w.ended.push(r), deps })
    await s.start('auto', { minutes: 0 })
    expect(s.current()?.expiresAt).toBeUndefined()
    deps.children[0]!.say('lost connection to edge')
    deps.children[0]!.die(1)
    await vi.waitFor(() => expect(w.ended).toHaveLength(1))
    expect(w.ended[0]).toContain('lost connection')
    expect(w.allowedHosts).toEqual(['kept.example'])
  })
})

describe('the server behind a public link', () => {
  class Idle implements Provider {
    id = 'openai' as const
    async *chat(): AsyncIterable<ProviderEvent> {
      yield { type: 'done', result: { content: 'ok', toolCalls: [] } }
    }
  }

  const rawGet = (port: number, path: string, headers: Record<string, string>) =>
    new Promise<{ status: number; body: any }>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, headers }, (res) => {
        let b = ''
        res.on('data', (c) => (b += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b ? JSON.parse(b) : {} }))
      })
      r.on('error', reject)
      r.end()
    })

  it('refuses the owner token on the public host, keeps limits per real client, and forgets the host after teardown', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-share-'))
    const host = new VaraHost({ config: () => DEFAULT_CONFIG, provider: () => new Idle(), hub: new McpHub(), access: new AccessStore(join(dir, 'host')), cwd: dir })
    const ownerToken = newOwnerToken()
    const allowedHosts: string[] = []
    const publicHosts: string[] = []
    let share: Sharing | null = null
    const server = await startServer({
      host,
      ownerToken,
      port: 0,
      allowedHosts,
      publicHosts,
      share: () => (share?.current() ? { url: share.current()!.url } : undefined),
      limits: { failures: 4, joins: 100 },
    })
    const deps = fakeDeps((c) => c.say('https://abc-def.trycloudflare.com'))
    share = new Sharing({ port: server.port, allowedHosts, publicHosts, setGuestBase: () => undefined, deps })
    try {
      // before sharing, the public name is not ours
      expect((await rawGet(server.port, '/api/health', { host: 'abc-def.trycloudflare.com' })).status).toBe(421)
      await share.start('auto', { minutes: 0 })
      const pub = { host: 'abc-def.trycloudflare.com' }
      expect((await rawGet(server.port, '/api/health', pub)).status).toBe(200)

      // the owner works locally and sees the share; through the public name the same token is refused
      const local = await rawGet(server.port, '/api/me', { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${ownerToken}` })
      expect(local.status).toBe(200)
      expect(local.body.share).toEqual({ url: 'https://abc-def.trycloudflare.com' })
      const viaTunnel = await rawGet(server.port, '/api/me', { ...pub, authorization: `Bearer ${ownerToken}` })
      expect(viaTunnel.status).toBe(403)
      expect(viaTunnel.body.error).toContain('host machine')

      // a guest does work through it
      const guest = host.access.redeem(host.access.createInvite({ ...PRESETS.viewer }, { label: 't', ttlMs: 60_000, maxUses: 1 }).token, 'Sam')
      if ('error' in guest) throw new Error(guest.error)
      expect((await rawGet(server.port, '/api/me', { ...pub, authorization: `Bearer ${guest.accessToken}` })).status).toBe(200)

      // a stranger guessing tokens on the public link is locked out per address — the local owner is unaffected
      const bad = { ...pub, authorization: 'Bearer nope', 'x-forwarded-for': '203.0.113.9' }
      for (let i = 0; i < 6; i++) await rawGet(server.port, '/api/me', bad)
      expect((await rawGet(server.port, '/api/me', bad)).status).toBe(429)
      expect((await rawGet(server.port, '/api/me', { ...pub, authorization: `Bearer ${guest.accessToken}`, 'x-forwarded-for': '198.51.100.7' })).status).toBe(200)
      expect((await rawGet(server.port, '/api/me', { host: `127.0.0.1:${server.port}`, authorization: `Bearer ${ownerToken}` })).status).toBe(200)

      await share.stop()
      expect((await rawGet(server.port, '/api/health', pub)).status).toBe(421)
    } finally {
      await share.stop()
      await host.closeAll()
      await server.close()
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
