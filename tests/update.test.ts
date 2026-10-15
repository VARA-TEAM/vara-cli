import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  assetName,
  checkForUpdate,
  compareVersions,
  latestRelease,
  packagedRoot,
  parseSums,
  prevDir,
  rollback,
  runUpdate,
  swapIn,
  type UpdateDeps,
} from '../src/update/updater.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex')

describe('version and checksum helpers', () => {
  it('compares versions numerically and never calls a non-version "newer"', () => {
    expect(compareVersions('0.10.0', '0.9.5')).toBe(1)
    expect(compareVersions('v1.0.0', '1.0.0')).toBe(0)
    expect(compareVersions('0.3.0', '0.3.1')).toBe(-1)
    expect(compareVersions('dev', '9.9.9')).toBe(0)
    expect(compareVersions('2.0.0-rc.1', '1.9.9')).toBe(1)
  })
  it('parses sha256sum lines, binary markers and Windows line endings', () => {
    const h = 'a'.repeat(64)
    const m = parseSums(`${h}  vara-win-x64.zip\r\n${'B'.repeat(64)} *vara-linux-x64.tar.gz\nnot a line\n`)
    expect(m.get('vara-win-x64.zip')).toBe(h)
    expect(m.get('vara-linux-x64.tar.gz')).toBe('b'.repeat(64))
    expect(m.size).toBe(2)
  })
  it('names the download per platform, and none where there is none', () => {
    expect(assetName('win32', 'x64')).toBe('vara-win-x64.zip')
    expect(assetName('darwin', 'arm64')).toBe('vara-macos-arm64.tar.gz')
    expect(assetName('linux', 'x64')).toBe('vara-linux-x64.tar.gz')
    expect(assetName('darwin', 'x64')).toBeNull()
  })
  it('recognises the packaged install only (node next to vara.mjs)', () => {
    expect(packagedRoot('/opt/vara/node', (p) => p.endsWith('vara.mjs'))).toBe('/opt/vara')
    expect(packagedRoot('/usr/bin/node', () => false)).toBeNull()
    expect(packagedRoot('/opt/vara/vara', () => true)).toBeNull()
  })
})

function release(tag: string, over: Record<string, unknown> = {}, assets = ['vara-linux-x64.tar.gz', 'vara-win-x64.zip', 'vara-macos-arm64.tar.gz', 'SHA256SUMS.txt']) {
  return { tag_name: tag, html_url: `https://github.com/o/r/releases/tag/${tag}`, draft: false, prerelease: false, assets: assets.map((n) => ({ name: n, browser_download_url: `https://dl.example/${tag}/${n}` })), ...over }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('latestRelease', () => {
  it('reads the stable release and refuses drafts, pre-releases and a missing repo', async () => {
    const f = vi.fn(async () => json(release('v0.4.0')))
    const r = await latestRelease({ fetch: f as never, repo: 'o/r' })
    expect(r).toMatchObject({ tag: 'v0.4.0', version: '0.4.0' })
    expect(r.assets.map((a) => a.name)).toContain('SHA256SUMS.txt')
    expect(String(f.mock.calls[0]![0])).toBe('https://api.github.com/repos/o/r/releases/latest')
    await expect(latestRelease({ fetch: (async () => json(release('v1', { prerelease: true }))) as never, repo: 'o/r' })).rejects.toThrow(/not a stable/)
    await expect(latestRelease({ fetch: (async () => json({}, 404)) as never, repo: 'o/r' })).rejects.toThrow(/no published release/)
    await expect(latestRelease({ fetch: f as never, repo: 'not a repo' })).rejects.toThrow(/owner\/name/)
  })
})

describe('the quiet update notice', () => {
  const setup = async () => ({ cacheFile: join(await mkdtemp(join(tmpdir(), 'vara-uc-')), 'c.json') })

  it('asks once per interval, reports a newer version, and stays silent when current', async () => {
    const { cacheFile } = await setup()
    const f = vi.fn(async () => json(release('v0.4.0')))
    const deps: UpdateDeps = { fetch: f as never, repo: 'o/r', currentVersion: '0.3.0' }
    const a = await checkForUpdate({ enabled: true, deps, cacheFile, packaged: true, now: 1_000 })
    expect(a).toMatchObject({ current: '0.3.0', latest: '0.4.0' })
    await checkForUpdate({ enabled: true, deps, cacheFile, packaged: true, now: 2_000 })
    expect(f).toHaveBeenCalledTimes(1) // cached
    await checkForUpdate({ enabled: true, deps, cacheFile, packaged: true, now: 1_000 + 25 * 3_600_000 })
    expect(f).toHaveBeenCalledTimes(2)
    const same = await checkForUpdate({ enabled: true, deps: { ...deps, currentVersion: '0.4.0' }, cacheFile, packaged: true, now: 3_000 })
    expect(same).toBeNull()
  })

  it('does nothing when switched off, for source/dev runs, or with the opt-out variable — and never asks', async () => {
    const { cacheFile } = await setup()
    const f = vi.fn(async () => json(release('v9.0.0')))
    const deps: UpdateDeps = { fetch: f as never, repo: 'o/r', currentVersion: '0.3.0' }
    expect(await checkForUpdate({ enabled: false, deps, cacheFile, packaged: true })).toBeNull()
    expect(await checkForUpdate({ enabled: true, deps, cacheFile, packaged: false })).toBeNull()
    expect(await checkForUpdate({ enabled: true, deps: { ...deps, currentVersion: 'dev' }, cacheFile, packaged: true })).toBeNull()
    process.env['VARA_NO_UPDATE_CHECK'] = '1'
    try {
      expect(await checkForUpdate({ enabled: true, deps, cacheFile, packaged: true })).toBeNull()
    } finally {
      delete process.env['VARA_NO_UPDATE_CHECK']
    }
    expect(f).not.toHaveBeenCalled()
  })

  it('a failing network is silent and is not retried on every start', async () => {
    const { cacheFile } = await setup()
    const f = vi.fn(async () => {
      throw new Error('offline')
    })
    const deps: UpdateDeps = { fetch: f as never, repo: 'o/r', currentVersion: '0.3.0' }
    expect(await checkForUpdate({ enabled: true, deps, cacheFile, packaged: true, now: 10_000 })).toBeNull()
    expect(await checkForUpdate({ enabled: true, deps, cacheFile, packaged: true, now: 10_000 + 60_000 })).toBeNull()
    expect(f).toHaveBeenCalledTimes(1)
    await checkForUpdate({ enabled: true, deps, cacheFile, packaged: true, now: 10_000 + 2 * 3_600_000 })
    expect(f).toHaveBeenCalledTimes(2)
  })

  it('the default config checks, and the setting exists', () => {
    expect(DEFAULT_CONFIG.updates.check).toBe(true)
  })
})

/** A fake installed package + a fake release server whose archive is a few bytes with the right hash. */
async function world(opts: { sums?: 'ok' | 'wrong' | 'missing' | 'unlisted'; reported?: string; withSums?: boolean } = {}) {
  const base = await mkdtemp(join(tmpdir(), 'vara-up-'))
  const root = join(base, 'vara')
  await mkdir(root)
  await writeFile(join(root, 'node'), 'OLD-NODE')
  await writeFile(join(root, 'node.exe'), 'OLD-NODE')
  await writeFile(join(root, 'vara.mjs'), 'OLD-APP')
  await writeFile(join(root, 'vara.cmd'), '@echo off\r\nlauncher\r\n')
  await writeFile(join(root, 'vara'), '#!/bin/sh\nlauncher\n')
  await writeFile(join(root, 'VERSION'), '0.3.0\n')
  const archiveBytes = Buffer.from('pretend-archive-bytes')
  const name = 'vara-linux-x64.tar.gz'
  const sums =
    opts.sums === 'missing' ? null : opts.sums === 'unlisted' ? `${sha('x')}  other.zip\n` : `${opts.sums === 'wrong' ? 'f'.repeat(64) : sha(archiveBytes)}  ${name}\n`
  const files: Record<string, Buffer | string> = { [`https://dl.example/v0.4.0/${name}`]: archiveBytes, ...(sums ? { 'https://dl.example/v0.4.0/SHA256SUMS.txt': sums } : {}) }
  const fetched: string[] = []
  const fetchFn = vi.fn(async (url: string) => {
    fetched.push(url)
    if (url.startsWith('https://api.github.com/')) return json(release('v0.4.0', {}, sums ? [name, 'SHA256SUMS.txt'] : [name]))
    const body = files[url]
    return body === undefined ? new Response('nope', { status: 404 }) : new Response(body as never, { status: 200 })
  })
  const extract = vi.fn(async (_archive: string, dest: string) => {
    const pkg = join(dest, 'vara')
    await mkdir(pkg)
    await writeFile(join(pkg, 'node'), 'NEW-NODE')
    await writeFile(join(pkg, 'node.exe'), 'NEW-NODE')
    await writeFile(join(pkg, 'vara.mjs'), 'NEW-APP')
    await writeFile(join(pkg, 'vara.cmd'), '@echo off\r\nlauncher\r\n')
    await writeFile(join(pkg, 'vara'), '#!/bin/sh\nlauncher\n')
    await writeFile(join(pkg, 'VERSION'), '0.4.0\n')
  })
  const deps: UpdateDeps = {
    fetch: fetchFn as never,
    repo: 'o/r',
    root,
    platform: 'linux',
    arch: 'x64',
    currentVersion: '0.3.0',
    extract,
    runVersion: async () => opts.reported ?? '0.4.0',
    tmp: base,
  }
  return { base, root, deps, fetched, extract }
}
const read = (p: string) => readFile(p, 'utf8')

describe('vara update', () => {
  it('check only reports; apply downloads, verifies, swaps entry by entry and keeps the old version', async () => {
    const w = await world()
    expect(await runUpdate({ apply: false }, w.deps)).toEqual({ status: 'available', current: '0.3.0', latest: '0.4.0' })
    expect(w.extract).not.toHaveBeenCalled()
    expect(await read(join(w.root, 'vara.mjs'))).toBe('OLD-APP')

    const done = await runUpdate({ apply: true }, w.deps)
    expect(done.status).toBe('updated')
    expect(await read(join(w.root, 'vara.mjs'))).toBe('NEW-APP')
    expect(await read(join(w.root, 'VERSION'))).toBe('0.4.0\n')
    // the previous version is kept for rollback
    const prev = prevDir(w.root)
    expect(await read(join(prev, 'vara.mjs'))).toBe('OLD-APP')
    expect(await read(join(prev, 'VERSION'))).toBe('0.3.0\n')
    // an unchanged launcher is not touched (a running .cmd must stay put)
    expect(existsSync(join(prev, 'vara.cmd'))).toBe(false)
    expect(await read(join(w.root, 'vara.cmd'))).toBe('@echo off\r\nlauncher\r\n')
    // the work folder is gone
    expect((await readdir(w.base)).filter((n) => n.startsWith('vara-update-'))).toEqual([])
  })

  it('is a no-op when already current, and --force reinstalls', async () => {
    const w = await world()
    const same = await runUpdate({ apply: true }, { ...w.deps, currentVersion: '0.4.0' })
    expect(same.status).toBe('up-to-date')
    expect(w.extract).not.toHaveBeenCalled()
    const forced = await runUpdate({ apply: true, force: true }, { ...w.deps, currentVersion: '0.4.0' })
    expect(forced.status).toBe('updated')
  })

  it.each([
    ['a wrong checksum', { sums: 'wrong' as const }, /checksum mismatch/],
    ['a missing SHA256SUMS.txt', { sums: 'missing' as const }, /cannot be verified/],
    ['an archive the sums do not list', { sums: 'unlisted' as const }, /does not list/],
    ['a new version that reports something else', { reported: '9.9.9' }, /reports "9.9.9"/],
  ])('refuses %s and changes nothing', async (_n, opts, why) => {
    const w = await world(opts)
    await expect(runUpdate({ apply: true }, w.deps)).rejects.toThrow(why)
    expect(await read(join(w.root, 'vara.mjs'))).toBe('OLD-APP')
    expect(existsSync(prevDir(w.root))).toBe(false)
  })

  it('refuses a package that fails its self-check', async () => {
    const w = await world()
    await expect(runUpdate({ apply: true }, { ...w.deps, runVersion: async () => Promise.reject(new Error('boom')) })).rejects.toThrow(/self-check.*boom/)
    expect(await read(join(w.root, 'vara.mjs'))).toBe('OLD-APP')
  })

  it('says why a source checkout cannot update itself', async () => {
    const w = await world()
    await expect(runUpdate({ apply: true }, { ...w.deps, root: undefined as never, platform: 'linux' })).rejects.toThrow(/not installed from a download/)
  })

  it('restores everything when the swap fails half way', async () => {
    const w = await world()
    const fresh = join(w.base, 'fresh')
    await mkdir(fresh)
    for (const [n, c] of [['node', 'N2'], ['vara.mjs', 'A2'], ['VERSION', '0.4.0\n']]) await writeFile(join(fresh, n!), c!)
    let calls = 0
    const flaky: typeof rename = async (a, b) => {
      if (++calls === 5) throw new Error('disk full')
      return rename(a, b)
    }
    await expect(swapIn(w.root, fresh, flaky)).rejects.toThrow(/previous version was restored/)
    expect(await read(join(w.root, 'vara.mjs'))).toBe('OLD-APP')
    expect(await read(join(w.root, 'node'))).toBe('OLD-NODE')
    expect(await read(join(w.root, 'VERSION'))).toBe('0.3.0\n')
  })

  it('rolls back, and rolling back again returns to the newer one', async () => {
    const w = await world()
    await runUpdate({ apply: true }, w.deps)
    const back = await rollback({ root: w.root })
    expect(back.restored).toBe('0.3.0')
    expect(await read(join(w.root, 'vara.mjs'))).toBe('OLD-APP')
    expect(await read(join(prevDir(w.root), 'vara.mjs'))).toBe('NEW-APP')
    expect((await rollback({ root: w.root })).restored).toBe('0.4.0')
    expect(await read(join(w.root, 'vara.mjs'))).toBe('NEW-APP')
    const none = await world()
    await expect(rollback({ root: none.root })).rejects.toThrow(/no previous version/)
  })
})

describe('real archive extraction', () => {
  it('unpacks an archive made by the system tar through the default extractor (skipped where tar is missing)', async () => {
    const { execFileSync } = await import('node:child_process')
    const dir = await mkdtemp(join(tmpdir(), 'vara-tar-'))
    try {
      const pkg = join(dir, 'src', 'vara')
      await mkdir(pkg, { recursive: true })
      for (const [n, c] of [['node', 'n'], ['node.exe', 'n'], ['vara.mjs', 'NEW'], ['VERSION', '0.4.0\n']]) await writeFile(join(pkg, n!), c!)
      const win = process.platform === 'win32'
      const tar = win ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
      const archive = join(dir, win ? 'a.zip' : 'a.tar.gz')
      execFileSync(tar, win ? ['-a', '-c', '-f', archive, '-C', join(dir, 'src'), 'vara'] : ['-czf', archive, '-C', join(dir, 'src'), 'vara'])
      const bytes = await readFile(archive)
      const name = assetName(process.platform, process.arch) ?? 'vara-linux-x64.tar.gz'
      const root = join(dir, 'install', 'vara')
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'vara.mjs'), 'OLD')
      const f = async (url: string) =>
        url.startsWith('https://api.github.com/') ? json(release('v0.4.0', {}, [name, 'SHA256SUMS.txt'])) : url.endsWith('SHA256SUMS.txt') ? new Response(`${sha(bytes)}  ${name}\n`) : new Response(bytes as never)
      const r = await runUpdate({ apply: true }, { fetch: f as never, repo: 'o/r', root, platform: process.platform, arch: process.arch === 'x64' || process.arch === 'arm64' ? process.arch : 'x64', currentVersion: '0.3.0', runVersion: async () => '0.4.0', tmp: dir })
      expect(r.status).toBe('updated')
      expect(await read(join(root, 'vara.mjs'))).toBe('NEW')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
  })
})

describe('the update notice reaches the owner only, and only while the check is on', () => {
  it('host.info', async () => {
    const { VaraHost } = await import('../src/server/host.js')
    const { McpHub } = await import('../src/mcp/hub.js')
    const { AccessStore, PRESETS } = await import('../src/server/access.js')
    const dir = await mkdtemp(join(tmpdir(), 'vara-ui-'))
    let cfg = DEFAULT_CONFIG
    const host = new VaraHost({
      config: () => cfg,
      provider: () => ({ id: 'openai', chat: async function* () {} }) as never,
      hub: new McpHub(),
      access: new AccessStore(join(dir, 'host')),
      cwd: dir,
      update: () => ({ current: '0.3.0', latest: '0.4.0', url: 'https://x' }),
    })
    const guest = { kind: 'guest' as const, id: 'g', name: 'G', grant: PRESETS.viewer }
    expect(host.info({ kind: 'owner' }).update).toMatchObject({ latest: '0.4.0' })
    expect(host.info(guest).update).toBeUndefined()
    cfg = { ...DEFAULT_CONFIG, updates: { check: false } }
    expect(host.info({ kind: 'owner' }).update).toBeUndefined()
  })
})
