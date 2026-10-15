import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { VARA_HOME } from '../config/paths.js'
import { VERSION } from '../version.js'

/**
 * Updates of the packaged install (the self-contained download):
 *
 *   check   → GitHub's "latest release" (no pre-releases, no drafts)
 *   fetch   → the archive for this OS/CPU, and SHA256SUMS.txt of the same release
 *   verify  → the archive's SHA-256 must match its line in SHA256SUMS.txt,
 *             and the unpacked program must report the release's version
 *   swap    → entry by entry with rename (atomic per entry), the old files kept
 *             in `vara.prev` next to the install; any failure restores them
 *   rollback→ `vara update --rollback` swaps back
 *
 * Network, extraction and process execution are injected, so every step is
 * tested without a network.
 *
 * Honest limit: the checksum list comes from the same release as the archive, so
 * it protects against corruption and wrong files — not against someone who can
 * publish to the release itself.
 */

export const DEFAULT_REPO = 'VARA-TEAM/vara-cli'
const MAX_ARCHIVE_BYTES = 400 * 1024 * 1024

export interface ReleaseInfo {
  tag: string
  version: string
  url: string
  assets: Array<{ name: string; url: string }>
}

export interface UpdateDeps {
  fetch?: typeof fetch
  repo?: string
  platform?: NodeJS.Platform
  arch?: string
  /** The install folder (contains node, vara.mjs). */
  root?: string
  currentVersion?: string
  /** Unpack an archive into a folder. */
  extract?: (archive: string, dest: string, platform: NodeJS.Platform) => Promise<void>
  /** Run the new program: returns what `--version` printed. */
  runVersion?: (node: string, script: string) => Promise<string>
  /** Scratch space. */
  tmp?: string
  timeoutMs?: number
  log?: (line: string) => void
}

/* ---------- pure helpers ---------- */

/** Numeric x.y.z comparison; anything that is not a version compares as equal (never "newer"). */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(v.trim())
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
  }
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return 0
  for (let i = 0; i < 3; i++) if (x[i]! !== y[i]!) return x[i]! < y[i]! ? -1 : 1
  return 0
}

/** `<64 hex>  <file>` lines (sha256sum / shasum format; `*` marks binary mode). */
export function parseSums(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const m = /^([a-fA-F0-9]{64})\s+\*?(\S+)\s*$/.exec(line.trim())
    if (m) out.set(m[2]!, m[1]!.toLowerCase())
  }
  return out
}

/** Name of the download for a platform, or null where none is published. */
export function assetName(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === 'win32' && arch === 'x64') return 'vara-win-x64.zip'
  if (platform === 'darwin' && arch === 'arm64') return 'vara-macos-arm64.tar.gz'
  if (platform === 'linux' && arch === 'x64') return 'vara-linux-x64.tar.gz'
  return null
}

/** The install folder when this process runs from the packaged download (node + vara.mjs side by side), else null. */
export function packagedRoot(execPath: string = process.execPath, exists: (p: string) => boolean = existsSync): string | null {
  const name = basename(execPath).toLowerCase()
  if (name !== 'node' && name !== 'node.exe') return null
  const root = dirname(execPath)
  return exists(join(root, 'vara.mjs')) ? root : null
}

const sha256File = async (file: string): Promise<string> => createHash('sha256').update(await readFile(file)).digest('hex')

/* ---------- looking for a release ---------- */

export async function latestRelease(deps: UpdateDeps = {}): Promise<ReleaseInfo> {
  const f = deps.fetch ?? fetch
  const repo = deps.repo ?? process.env['VARA_REPO'] ?? DEFAULT_REPO
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`VARA_REPO must look like owner/name, got "${repo}"`)
  const res = await f(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': `vara/${deps.currentVersion ?? VERSION}` },
    signal: AbortSignal.timeout(deps.timeoutMs ?? 8_000),
  })
  if (res.status === 404) throw new Error('no published release found (the repository may be private or have no releases)')
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const body = (await res.json()) as { tag_name?: string; html_url?: string; draft?: boolean; prerelease?: boolean; assets?: Array<{ name?: string; browser_download_url?: string }> }
  if (!body.tag_name || body.draft || body.prerelease) throw new Error('the latest release is not a stable release')
  return {
    tag: body.tag_name,
    version: body.tag_name.replace(/^v/, ''),
    url: body.html_url ?? `https://github.com/${repo}/releases/tag/${body.tag_name}`,
    assets: (body.assets ?? []).filter((a) => a.name && a.browser_download_url).map((a) => ({ name: a.name!, url: a.browser_download_url! })),
  }
}

/* ---------- the quiet check behind the "update available" notice ---------- */

export interface UpdateNotice {
  current: string
  latest: string
  url: string
}

interface CacheFile {
  checkedAt: number
  latest?: string
  url?: string
}

export const updateCacheFile = (): string => join(VARA_HOME, 'update-check.json')

/**
 * Is a newer release out? Asks GitHub at most once per `intervalMs` (the answer is cached on disk),
 * never throws, and returns null on any failure — a missing network must never bother anyone.
 * Skips itself for source/dev runs (nothing `vara update` could replace) and when switched off.
 */
export async function checkForUpdate(opts: {
  enabled: boolean
  deps?: UpdateDeps
  cacheFile?: string
  intervalMs?: number
  now?: number
  packaged?: boolean
}): Promise<UpdateNotice | null> {
  const current = opts.deps?.currentVersion ?? VERSION
  if (!opts.enabled || process.env['VARA_NO_UPDATE_CHECK'] || current === 'dev') return null
  if (!(opts.packaged ?? packagedRoot() !== null)) return null
  const file = opts.cacheFile ?? updateCacheFile()
  const now = opts.now ?? Date.now()
  const interval = opts.intervalMs ?? 24 * 3_600_000
  let cache: CacheFile | null = null
  try {
    cache = JSON.parse(await readFile(file, 'utf8')) as CacheFile
  } catch {
    cache = null
  }
  if (!cache || now - cache.checkedAt > interval || typeof cache.checkedAt !== 'number') {
    try {
      const r = await latestRelease({ ...opts.deps, timeoutMs: opts.deps?.timeoutMs ?? 4_000 })
      cache = { checkedAt: now, latest: r.version, url: r.url }
    } catch {
      // Remember the failure for an hour so an offline machine does not retry on every start.
      cache = { checkedAt: now - interval + 3_600_000, ...(cache?.latest ? { latest: cache.latest, url: cache.url } : {}) }
    }
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(cache))
    } catch {
      /* a cache is a convenience */
    }
  }
  if (cache.latest && compareVersions(cache.latest, current) > 0) return { current, latest: cache.latest, url: cache.url ?? '' }
  return null
}

/* ---------- performing the update ---------- */

export interface UpdateResult {
  status: 'up-to-date' | 'available' | 'updated'
  current: string
  latest: string
}

const defaultExtract: NonNullable<UpdateDeps['extract']> = (archive, dest, platform) =>
  new Promise((resolve, reject) => {
    // Windows: the system bsdtar (a Git-for-Windows tar earlier on PATH reads "C:" as a remote host).
    const tar = platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
    execFile(tar, platform === 'win32' ? ['-xf', archive, '-C', dest] : ['-xzf', archive, '-C', dest], { windowsHide: true }, (err) => (err ? reject(new Error(`could not unpack the update: ${err.message}`)) : resolve()))
  })

const defaultRunVersion: NonNullable<UpdateDeps['runVersion']> = (node, script) =>
  new Promise((resolve, reject) => {
    execFile(node, [script, '--version'], { timeout: 20_000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout.trim())))
  })

/** Check, and with `apply` download, verify and install the latest release. */
export async function runUpdate(opts: { apply: boolean; force?: boolean }, deps: UpdateDeps = {}): Promise<UpdateResult> {
  const log = deps.log ?? (() => undefined)
  const current = deps.currentVersion ?? VERSION
  const root = deps.root ?? packagedRoot()
  if (!root) throw new Error('this copy of VARA was not installed from a download (no bundled runtime next to it), so it cannot update itself. Update it the way you installed it (git pull / npm install), or reinstall from the Releases page.')
  const platform = deps.platform ?? process.platform
  const arch = deps.arch ?? process.arch
  const name = assetName(platform, arch)
  if (!name) throw new Error(`there is no published download for ${platform}-${arch}`)

  const release = await latestRelease(deps)
  const newer = compareVersions(release.version, current) > 0
  if (!newer && !opts.force) return { status: 'up-to-date', current, latest: release.version }
  if (!opts.apply) return { status: 'available', current, latest: release.version }

  const f = deps.fetch ?? fetch
  const asset = release.assets.find((a) => a.name === name)
  const sums = release.assets.find((a) => a.name === 'SHA256SUMS.txt')
  if (!asset) throw new Error(`release ${release.tag} has no ${name}`)
  if (!sums) throw new Error(`release ${release.tag} has no SHA256SUMS.txt — refusing to install something that cannot be verified`)

  const work = await mkdtemp(join(deps.tmp ?? tmpdir(), 'vara-update-'))
  try {
    log(`downloading ${name} (${release.tag})…`)
    const sumsRes = await f(sums.url, { signal: AbortSignal.timeout(deps.timeoutMs ?? 30_000) })
    if (!sumsRes.ok) throw new Error(`could not download SHA256SUMS.txt (${sumsRes.status})`)
    const expected = parseSums(await sumsRes.text()).get(name)
    if (!expected) throw new Error(`SHA256SUMS.txt does not list ${name} — refusing to install`)

    const archive = join(work, name)
    const res = await f(asset.url, { signal: AbortSignal.timeout((deps.timeoutMs ?? 30_000) * 10) })
    if (!res.ok || !res.body) throw new Error(`could not download ${name} (${res.status})`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_ARCHIVE_BYTES) throw new Error('the download is larger than expected — refusing it')
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(archive))
    log('verifying checksum…')
    const actual = await sha256File(archive)
    if (actual !== expected) throw new Error(`checksum mismatch (expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…) — nothing was changed`)

    log('unpacking…')
    const fresh = join(work, 'unpacked')
    await mkdir(fresh)
    await (deps.extract ?? defaultExtract)(archive, fresh, platform)
    const pkg = join(fresh, 'vara')
    const nodeName = platform === 'win32' ? 'node.exe' : 'node'
    if (!existsSync(join(pkg, nodeName)) || !existsSync(join(pkg, 'vara.mjs'))) throw new Error('the download does not look like a VARA package — nothing was changed')

    log('checking the new version runs…')
    const said = await (deps.runVersion ?? defaultRunVersion)(join(pkg, nodeName), join(pkg, 'vara.mjs')).catch((e: Error) => {
      throw new Error(`the new version failed its self-check (${e.message}) — nothing was changed`)
    })
    if (said !== release.version) throw new Error(`the new version reports "${said}", expected "${release.version}" — nothing was changed`)

    log('installing (previous version kept for rollback)…')
    await swapIn(root, pkg)
    return { status: 'updated', current, latest: release.version }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined)
  }
}

/** Where the previous version waits, next to the install folder. */
export const prevDir = (root: string): string => join(dirname(root), `${basename(root)}.prev`)

async function sameBytes(a: string, b: string): Promise<boolean> {
  try {
    const [x, y] = await Promise.all([readFile(a), readFile(b)])
    return x.length === y.length && x.length < 64 * 1024 && x.equals(y)
  } catch {
    return false
  }
}

/**
 * Replace the files of `root` with those of `fresh`, entry by entry. Each rename is atomic; the old
 * entries go to `<root>.prev`. Small launcher scripts that did not change are left untouched (on Windows
 * the running .cmd must not be replaced under cmd.exe). On any error everything is put back.
 */
export async function swapIn(root: string, fresh: string, mv: typeof rename = rename): Promise<void> {
  const prev = prevDir(root)
  await rm(prev, { recursive: true, force: true })
  await mkdir(prev, { recursive: true })
  const moved: string[] = []
  const placed: string[] = []
  try {
    for (const entry of await readdir(fresh)) {
      const target = join(root, entry)
      if (existsSync(target)) {
        if (await sameBytes(target, join(fresh, entry))) continue
        await mv(target, join(prev, entry))
        moved.push(entry)
      }
      await mv(join(fresh, entry), target)
      placed.push(entry)
    }
  } catch (err) {
    for (const entry of placed) await rm(join(root, entry), { recursive: true, force: true }).catch(() => undefined)
    for (const entry of moved) await rename(join(prev, entry), join(root, entry)).catch(() => undefined)
    throw new Error(`could not install the update (${(err as Error).message}); the previous version was restored`)
  }
}

/** Swap the previous version back in (the one just replaced becomes the new "previous", so it can be undone). */
export async function rollback(deps: UpdateDeps = {}): Promise<{ restored: string }> {
  const root = deps.root ?? packagedRoot()
  if (!root) throw new Error('this copy of VARA was not installed from a download — there is nothing to roll back')
  const prev = prevDir(root)
  if (!existsSync(prev) || (await readdir(prev)).length === 0) throw new Error('there is no previous version to go back to')
  const restored = await readFile(join(prev, 'VERSION'), 'utf8').then((s) => s.trim()).catch(() => 'the previous version')
  const holding = `${prev}.swap`
  await rm(holding, { recursive: true, force: true })
  await mkdir(holding, { recursive: true })
  const toPrev: string[] = []
  const fromPrev: string[] = []
  try {
    for (const entry of await readdir(prev)) {
      const target = join(root, entry)
      if (existsSync(target)) {
        await rename(target, join(holding, entry))
        toPrev.push(entry)
      }
      await rename(join(prev, entry), target)
      fromPrev.push(entry)
    }
  } catch (err) {
    for (const entry of fromPrev) await rename(join(root, entry), join(prev, entry)).catch(() => undefined)
    for (const entry of toPrev) await rename(join(holding, entry), join(root, entry)).catch(() => undefined)
    throw new Error(`could not roll back (${(err as Error).message}); nothing was changed`)
  }
  await rm(prev, { recursive: true, force: true })
  await rename(holding, prev)
  return { restored }
}
