import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { AccessStore } from '../src/server/access.js'
import { isLoopback, makeLogger, makeShutdown, newToken, ownerDigestFile, parseServeSettings, resolveOwnerAuth, sha256, tokenMatches, tokenProblem, validHostName } from '../src/server/daemon.js'
import { serverChecks, type ServerProbes } from '../src/server/doctor-server.js'
import { serveCommand } from '../src/server/commands.js'
import { VaraHost } from '../src/server/host.js'
import { startServer } from '../src/server/http.js'

let tmp: string
beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'vara-daemon-'))
})
afterAll(async () => {
  await rm(tmp, { recursive: true, force: true })
})

const LONG = 'T0ken-that-is-long-enough-to-be-fine-123'

describe('serve settings: flags, environment, safe defaults', () => {
  it('defaults to loopback on 7777 and needs nothing else', () => {
    const s = parseServeSettings([], {})
    expect(s).toMatchObject({ port: 7777, bind: '127.0.0.1', trustProxy: false, log: 'text', daemon: true, tokenFrom: 'persisted', rotateToken: false })
    expect(s.warnings).toEqual([])
    expect(isLoopback(s.bind)).toBe(true)
  })

  it('an empty variable (compose `${VAR:-}`) is "not set", never port 0 or a blank host', () => {
    const s = parseServeSettings([], { VARA_PORT: '', VARA_BIND: ' ', VARA_PUBLIC_HOST: '', VARA_OWNER_TOKEN: '', VARA_OWNER_TOKEN_FILE: '', VARA_LOG: '', VARA_CWD: '' })
    expect(s).toMatchObject({ port: 7777, bind: '127.0.0.1', tokenFrom: 'persisted', log: 'text' })
    expect(s.publicHost).toBeUndefined()
    expect(s.token).toBeUndefined()
  })

  it('reads VARA_* variables, and a flag beats the variable', () => {
    const env = { VARA_PORT: '9000', VARA_BIND: '0.0.0.0', VARA_PUBLIC_HOST: 'https://Vara.Example.com/', VARA_CWD: tmp, VARA_LOG: 'json', VARA_TRUST_PROXY: '1' }
    const s = parseServeSettings([], env)
    expect(s).toMatchObject({ port: 9000, bind: '0.0.0.0', publicHost: 'Vara.Example.com', cwd: tmp, log: 'json', trustProxy: true })
    expect(parseServeSettings(['--port', '9100', '--bind', '127.0.0.1'], env)).toMatchObject({ port: 9100, bind: '127.0.0.1' })
  })

  it('a non-loopback bind always comes with a warning about TLS and the token', () => {
    const s = parseServeSettings(['--bind', '0.0.0.0'], {})
    expect(s.warnings.join('\n')).toMatch(/plain HTTP/)
    expect(s.warnings.join('\n')).toMatch(/no --public-host/)
    const lan = parseServeSettings(['--lan'], {})
    expect(lan.bind).toBe('0.0.0.0')
    expect(lan.warnings.length).toBeGreaterThan(0)
    expect(parseServeSettings(['--public-host', 'v.example.com'], {}).warnings.join('\n')).toMatch(/--trust-proxy/)
    expect(parseServeSettings(['--bind', '0.0.0.0', '--trust-proxy', '--public-host', 'v.example.com'], {}).warnings.join('\n')).toMatch(/forged/)
  })

  it('refuses what cannot work or is unsafe', () => {
    expect(() => parseServeSettings(['--port', '99999'], {})).toThrow(/port/)
    expect(() => parseServeSettings(['--port', 'abc'], {})).toThrow(/port/)
    expect(() => parseServeSettings(['--lan', '--bind', '0.0.0.0'], {})).toThrow(/either/)
    expect(() => parseServeSettings(['--public-host', 'bad host/with path'], {})).toThrow(/DNS name/)
    expect(() => parseServeSettings(['--public-host', 'vara.example.com:8080'], {})).toThrow(/DNS name/)
    expect(() => parseServeSettings(['--log', 'xml'], {})).toThrow(/--log/)
    expect(() => parseServeSettings(['--token', 'short'], {})).toThrow(/too short/)
    expect(() => parseServeSettings([], { VARA_OWNER_TOKEN: 'short' })).toThrow(/too short/)
    expect(() => parseServeSettings(['--token-file', 'a', '--token', LONG], {})).toThrow(/ONE way/)
    expect(() => parseServeSettings(['--token'], {})).toThrow(/needs a value/)
    expect(() => parseServeSettings(['--rotate-token', '--token', LONG], {})).toThrow(/generated token/)
    expect(() => parseServeSettings(['--token-file', 'x'], {}, { daemon: false })).toThrow(/vara ui/)
  })

  it('token sources: file / variable / flag (the flag warns), with their precedence', () => {
    expect(parseServeSettings(['--token-file', join(tmp, 't')], {})).toMatchObject({ tokenFrom: 'file' })
    expect(parseServeSettings([], { VARA_OWNER_TOKEN_FILE: join(tmp, 't') })).toMatchObject({ tokenFrom: 'env-file' })
    expect(parseServeSettings([], { VARA_OWNER_TOKEN: LONG })).toMatchObject({ tokenFrom: 'env', token: LONG })
    const flagged = parseServeSettings(['--token', LONG], { VARA_OWNER_TOKEN: LONG + 'x' })
    expect(flagged).toMatchObject({ tokenFrom: 'flag', token: LONG })
    expect(flagged.warnings.join('\n')).toMatch(/process list/)
    expect(tokenProblem('x'.repeat(23))).toMatch(/too short/)
    expect(tokenProblem('a b'.repeat(10))).toMatch(/spaces/)
    expect(tokenProblem(LONG)).toBeNull()
  })

  it('under systemd (JOURNAL_STREAM) the log defaults to journal format', () => {
    expect(parseServeSettings([], { JOURNAL_STREAM: '8:1234' }).log).toBe('journal')
    expect(parseServeSettings([], { JOURNAL_STREAM: '8:1234', VARA_LOG: 'json' }).log).toBe('json')
    expect(validHostName('vara.example.com')).toBe(true)
    expect(validHostName('-bad.example.com')).toBe(false)
  })
})

describe('the owner token survives restarts without being stored', () => {
  it('is generated once, shown once, and only its digest is kept (0600)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-host-'))
    const first = resolveOwnerAuth({ rotateToken: false }, dir)
    expect(first.source).toBe('generated')
    expect(first.oneTimeToken).toHaveLength(43)
    expect(tokenMatches(first.oneTimeToken!, first.digest)).toBe(true)
    expect(tokenMatches('wrong-token-wrong-token-wrong', first.digest)).toBe(false)
    expect(tokenMatches('', first.digest)).toBe(false)

    const file = ownerDigestFile(dir)
    const saved = readFileSync(file, 'utf8')
    expect(saved).not.toContain(first.oneTimeToken!) // the token itself is nowhere on disk
    expect(saved).toContain(sha256(first.oneTimeToken!).toString('hex'))
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)

    const again = resolveOwnerAuth({ rotateToken: false }, dir)
    expect(again.source).toBe('persisted')
    expect(again.oneTimeToken).toBeUndefined() // never shown a second time
    expect(tokenMatches(first.oneTimeToken!, again.digest)).toBe(true)

    const rotated = resolveOwnerAuth({ rotateToken: true }, dir)
    expect(rotated.source).toBe('generated')
    expect(tokenMatches(first.oneTimeToken!, rotated.digest)).toBe(false) // the old one stops working
    expect(tokenMatches(rotated.oneTimeToken!, resolveOwnerAuth({ rotateToken: false }, dir).digest)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('a provided token (file or value) is used as given and never persisted', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-host-'))
    const f = join(dir, 'token')
    writeFileSync(f, `\n${LONG}\n`)
    const a = resolveOwnerAuth({ rotateToken: false, tokenFile: f }, dir)
    expect(a).toMatchObject({ source: 'provided' })
    expect(tokenMatches(LONG, a.digest)).toBe(true)
    expect(existsSync(ownerDigestFile(dir))).toBe(false)
    writeFileSync(f, 'tiny')
    expect(() => resolveOwnerAuth({ rotateToken: false, tokenFile: f }, dir)).toThrow(/too short/)
    expect(() => resolveOwnerAuth({ rotateToken: false, tokenFile: join(dir, 'missing') }, dir)).toThrow(/cannot read/)
    expect(tokenMatches(LONG, resolveOwnerAuth({ rotateToken: false, token: LONG }, dir).digest)).toBe(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('a damaged digest file is replaced, loudly', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-host-'))
    writeFileSync(ownerDigestFile(dir), '{not json')
    const a = resolveOwnerAuth({ rotateToken: false }, dir)
    expect(a.source).toBe('generated')
    expect(a.warnings.join('\n')).toMatch(/unreadable/)
    await rm(dir, { recursive: true, force: true })
  })

  it('tokens are long and distinct', () => {
    expect(newToken()).not.toBe(newToken())
    expect(newToken().length).toBeGreaterThanOrEqual(43)
  })
})

describe('log lines for journald, containers and people', () => {
  const at = () => new Date('2026-10-15T10:00:00.000Z')
  const collect = (mode: 'text' | 'json' | 'journal') => {
    const lines: string[] = []
    return { log: makeLogger(mode, (l) => lines.push(l), at), lines }
  }

  it('journal: syslog priority prefix, no timestamp, one line each', () => {
    const { log, lines } = collect('journal')
    log.info('up', { port: 7777 })
    log.warn('careful\nwith newlines')
    log.error('boom')
    expect(lines).toEqual(['<6>up port=7777', '<4>careful with newlines', '<3>boom'])
  })

  it('json: one object per line, machine readable', () => {
    const { log, lines } = collect('json')
    log.error('internal error', { message: 'x' })
    log.raw('Owner login: https://h/#token=abc')
    const [a, b] = lines.map((l) => JSON.parse(l))
    expect(a).toMatchObject({ ts: '2026-10-15T10:00:00.000Z', level: 'error', msg: 'internal error', message: 'x' })
    expect(b.msg).toContain('Owner login')
  })

  it('text: timestamp, level, message', () => {
    const { log, lines } = collect('text')
    log.info('hello')
    expect(lines[0]).toBe('2026-10-15T10:00:00.000Z INFO  hello')
  })
})

describe('shutdown: ordered, idempotent, never stuck', () => {
  const quiet = makeLogger('text', () => {})

  it('runs every step in order, once, even when asked twice', async () => {
    const order: string[] = []
    const stop = makeShutdown({ log: quiet, steps: [{ name: 'a', run: () => void order.push('a') }, { name: 'b', run: async () => void order.push('b') }] })
    const [x, y] = await Promise.all([stop('SIGTERM'), stop('SIGINT')])
    expect(order).toEqual(['a', 'b'])
    expect(x).toBe(y)
    expect(x.clean).toBe(true)
  })

  it('a failing or hanging step does not stop the next ones, and the result says it was not clean', async () => {
    const order: string[] = []
    const stop = makeShutdown({
      log: quiet,
      stepTimeoutMs: 30,
      steps: [
        { name: 'throws', run: () => Promise.reject(new Error('nope')) },
        { name: 'hangs', run: () => new Promise(() => {}) },
        { name: 'last', run: () => void order.push('last') },
      ],
    })
    const r = await stop('test')
    expect(order).toEqual(['last'])
    expect(r.clean).toBe(false)
  })
})

describe('the doctor for servers', () => {
  const probes = (over: Partial<ServerProbes> = {}): ServerProbes => ({
    home: tmp,
    hostDir: join(tmp, 'host-doctor'),
    portFree: async () => true,
    health: async (url) => ({ ok: true, detail: `${url} answers` }),
    alive: () => false,
    uiBuilt: () => true,
    providerKey: async () => ({ ok: true, detail: 'openai · gpt-4o (key: env)' }),
    inContainer: () => false,
    ...over,
  })
  const by = (list: Awaited<ReturnType<typeof serverChecks>>, name: string) => list.find((c) => c.name === name)!

  it('a healthy loopback setup passes', async () => {
    const c = await serverChecks(['--cwd', tmp], {}, probes())
    expect(c.filter((x) => !x.ok && !x.optional)).toEqual([])
    expect(by(c, 'Exposure').detail).toMatch(/loopback/)
    expect(by(c, 'Owner token').detail).toMatch(/none yet/)
  })

  it('reports a busy port, a missing key, a bad token file and an unreachable public URL', async () => {
    const c = await serverChecks(['--cwd', tmp, '--bind', '0.0.0.0', '--public-host', 'v.example.com', '--token-file', join(tmp, 'nope')], {}, probes({ portFree: async () => false, providerKey: async () => ({ ok: false, detail: 'no key' }), health: async () => ({ ok: false, detail: 'https://v.example.com/api/health is not reachable' }) }))
    expect(by(c, 'Port').ok).toBe(false)
    expect(by(c, 'Provider').ok).toBe(false)
    expect(by(c, 'Owner token').ok).toBe(false)
    expect(by(c, 'Public URL').ok).toBe(false)
    expect(by(c, 'Proxy').detail).toMatch(/trust-proxy/)
    expect(by(c, 'Exposure').detail).toMatch(/TLS/)
  })

  it('in a container a loopback bind is an error, and a wide bind is expected', async () => {
    const bad = await serverChecks(['--cwd', tmp], {}, probes({ inContainer: () => true }))
    expect(by(bad, 'Container').ok).toBe(false)
    const good = await serverChecks(['--cwd', tmp, '--bind', '0.0.0.0'], {}, probes({ inContainer: () => true }))
    expect(good.find((x) => x.name === 'Container')).toBeUndefined()
    expect(by(good, 'Exposure').detail).toMatch(/127\.0\.0\.1:7777/)
  })

  it('invalid settings are reported instead of thrown', async () => {
    const c = await serverChecks(['--port', 'x'], {}, probes())
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ name: 'Settings', ok: false })
  })
})

describe('the proxy-aware login limit', () => {
  it('counts failed logins per real client behind a trusted proxy, and together without one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-rl-'))
    const mk = async (trustProxy: boolean) => {
      const host = new VaraHost({ config: () => DEFAULT_CONFIG, provider: () => ({ id: 'openai', chat: async function* () {} }) as never, hub: new McpHub(), access: new AccessStore(join(dir, `host-${trustProxy}`)), cwd: dir })
      const digest = sha256(LONG)
      const server = await startServer({ host, ownerTokenDigest: digest, port: 0, trustProxy, limits: { failures: 3 } })
      const hit = async (token: string, xff?: string): Promise<number> => {
        const res = await fetch(`http://127.0.0.1:${server.port}/api/me`, { headers: { authorization: `Bearer ${token}`, ...(xff ? { 'x-forwarded-for': xff } : {}) } })
        return res.status
      }
      return { server, host, hit }
    }
    const trusted = await mk(true)
    for (let i = 0; i < 4; i++) await trusted.hit('wrong-wrong-wrong-wrong-wrong', '203.0.113.9')
    expect(await trusted.hit('wrong', '203.0.113.9')).toBe(429) // that client is locked out…
    expect(await trusted.hit(LONG, '198.51.100.7')).toBe(200) // …the owner, a different client, is not
    // the owner's token (digest comparison) works, and a wrong one never does
    expect(await trusted.hit('x'.repeat(30), '198.51.100.7')).toBe(401)
    await trusted.host.closeAll()
    await trusted.server.close()

    const naive = await mk(false)
    for (let i = 0; i < 4; i++) await naive.hit('wrong-wrong-wrong-wrong-wrong', '203.0.113.9')
    expect(await naive.hit(LONG, '198.51.100.7')).toBe(429) // without trusting the proxy, everyone shares one address
    await naive.host.closeAll()
    await naive.server.close()
    await rm(dir, { recursive: true, force: true })
  })
})

describe('vara serve, end to end (in this process)', () => {
  const get = (port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> =>
    new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
      })
      req.on('error', reject)
      req.end()
    })

  async function runOnce(extra: string[], work: string) {
    const lines: string[] = []
    const ac = new AbortController()
    let ready!: { port: number; oneTimeToken?: string; ownerUrl?: string }
    const done = serveCommand(['--port', '0', '--cwd', work, '--log', 'journal', ...extra], false, { write: (l) => lines.push(l), onReady: (i) => (ready = i), abort: ac.signal })
    const end = Date.now() + 15_000
    while (!ready && Date.now() < end) await new Promise((r) => setTimeout(r, 25))
    if (!ready) throw new Error(`the host did not start; log: ${lines.join(' | ')}`)
    return { ready, lines, stop: async () => (ac.abort(), await done) }
  }

  it('starts, answers the health check, authenticates the persisted owner token, survives a restart, and stops cleanly', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-not-a-real-key-0000000000'
    process.env['VARA_NO_UPDATE_CHECK'] = '1'
    const work = await mkdtemp(join(tmpdir(), 'vara-serve-'))
    try {
      const a = await runOnce([], work)
      expect(a.ready.oneTimeToken).toHaveLength(43)
      expect(a.lines.join('\n')).toMatch(/Owner login — shown ONCE/)
      expect(a.lines.join('\n')).toContain(`#token=${a.ready.oneTimeToken}`)
      expect(a.lines.every((l) => /^<[0-9]>/.test(l))).toBe(true) // journald priorities
      const health = await get(a.ready.port, '/api/health')
      expect(health.status).toBe(200)
      expect(JSON.parse(health.body)).toMatchObject({ ok: true, name: 'vara' })
      expect((await get(a.ready.port, '/api/me')).status).toBe(401)
      const me = await get(a.ready.port, '/api/me', { authorization: `Bearer ${a.ready.oneTimeToken}` })
      expect(me.status).toBe(200)
      expect(JSON.parse(me.body).role).toBe('owner')
      // a domain name in the Host header is refused unless --public-host allows it (DNS rebinding)
      expect((await get(a.ready.port, '/api/health', { host: 'evil.example.com' })).status).toBe(421)
      const info = join(process.env['VARA_HOME']!, 'host', 'running.json')
      expect(existsSync(info)).toBe(true)
      await a.stop()
      expect(existsSync(info)).toBe(false) // forgot itself
      await expect(get(a.ready.port, '/api/health')).rejects.toThrow() // the port is closed

      // restart: the same token still works and is NOT printed again
      const b = await runOnce([], work)
      expect(b.ready.oneTimeToken).toBeUndefined()
      expect(b.lines.join('\n')).not.toContain(a.ready.oneTimeToken!)
      expect((await get(b.ready.port, '/api/me', { authorization: `Bearer ${a.ready.oneTimeToken}` })).status).toBe(200)
      await b.stop()

      // rotate: the old token stops working, a new one is shown
      const c = await runOnce(['--rotate-token'], work)
      expect(c.ready.oneTimeToken).toBeTruthy()
      expect(c.ready.oneTimeToken).not.toBe(a.ready.oneTimeToken)
      expect((await get(c.ready.port, '/api/me', { authorization: `Bearer ${a.ready.oneTimeToken}` })).status).toBe(401)
      expect((await get(c.ready.port, '/api/me', { authorization: `Bearer ${c.ready.oneTimeToken}` })).status).toBe(200)
      await c.stop()
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 60_000)

  it('a wide bind starts only with a warning, and never prints the provided token', async () => {
    process.env['OPENAI_API_KEY'] = 'sk-test-not-a-real-key-0000000000'
    process.env['VARA_NO_UPDATE_CHECK'] = '1'
    const work = await mkdtemp(join(tmpdir(), 'vara-serve-'))
    const f = join(work, 'owner.token')
    writeFileSync(f, LONG)
    try {
      const a = await runOnce(['--bind', '0.0.0.0', '--token-file', f], work)
      const log = a.lines.join('\n')
      expect(log).toMatch(/<4>listening on 0\.0\.0\.0/)
      expect(log).not.toContain(LONG)
      expect(a.ready.oneTimeToken).toBeUndefined()
      expect((await get(a.ready.port, '/api/me', { authorization: `Bearer ${LONG}` })).status).toBe(200)
      await a.stop()
    } finally {
      await rm(work, { recursive: true, force: true })
    }
  }, 60_000)
})
