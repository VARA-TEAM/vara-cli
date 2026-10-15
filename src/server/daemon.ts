import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * Running VARA as a service (`vara serve`): everything that is configuration, not wiring — flags and
 * environment variables, the safety rules for where it listens, the owner token that survives restarts, the
 * log format for journald/containers, and a shutdown that is safe to ask for twice. All of it is pure or takes
 * its dependencies as arguments, so it is unit-tested without starting a server.
 */

export type Env = Record<string, string | undefined>
export type LogMode = 'text' | 'json' | 'journal'

export const DEFAULT_PORT = 7777
export const MIN_TOKEN_LENGTH = 24

export interface ServeSettings {
  port: number
  /** Address to listen on. */
  bind: string
  /** The public DNS name a reverse proxy serves this host on (no scheme). */
  publicHost?: string
  cwd: string
  /** A token the operator provides (never printed). */
  token?: string
  tokenFile?: string
  tokenFrom: 'flag' | 'env' | 'file' | 'env-file' | 'persisted'
  rotateToken: boolean
  log: LogMode
  /** Behind a reverse proxy that sets X-Forwarded-For: count failed logins per real client. */
  trustProxy: boolean
  /** `vara ui`: open a browser, per-run token. `vara serve`: headless daemon. */
  daemon: boolean
  /** Things the operator should read at start. */
  warnings: string[]
}

export const isLoopback = (bind: string): boolean => bind === '127.0.0.1' || bind === 'localhost' || bind === '::1'

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const truthy = (v: string | undefined): boolean => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim())

/** A DNS name, no scheme, path or port: what goes in the Host header. */
export function validHostName(h: string): boolean {
  return /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i.test(h)
}

/** Why a token is not acceptable, or null. Operator-provided tokens must be long enough to be unguessable. */
export function tokenProblem(token: string): string | null {
  if (token.length < MIN_TOKEN_LENGTH) return `the owner token is too short (${token.length} characters; use at least ${MIN_TOKEN_LENGTH}, e.g. \`openssl rand -base64 32\`)`
  if (/\s/.test(token)) return 'the owner token must not contain spaces or line breaks'
  return null
}

/**
 * Flags win over environment variables, which win over defaults. Throws a readable message for anything that
 * would make the host unsafe or unusable; everything softer is returned in `warnings`.
 */
export function parseServeSettings(args: string[], env: Env, opts: { daemon: boolean; cwd?: string } = { daemon: true }): ServeSettings {
  const warnings: string[] = []
  // An empty variable (compose's `${VAR:-}`, an unset export) means "not set", never "zero" or "blank".
  const e = (k: string): string | undefined => (env[k]?.trim() ? env[k]!.trim() : undefined)
  const portText = flag(args, '--port') ?? e('VARA_PORT') ?? String(DEFAULT_PORT)
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`the port must be a number from 0 to 65535 (got "${portText}")`)

  // --public means "reachable from anywhere by this machine's IP": the same listener as --lan, said honestly.
  const lan = args.includes('--lan') || args.includes('--public')
  const bindText = flag(args, '--bind') ?? e('VARA_BIND')
  if (lan && bindText) throw new Error('use either --lan / --public or --bind <address>, not both')
  const bind = (bindText ?? (lan ? '0.0.0.0' : '127.0.0.1')).trim()
  if (!bind || /\s/.test(bind)) throw new Error('--bind needs an address such as 127.0.0.1 or 0.0.0.0')

  const publicHostRaw = flag(args, '--public-host') ?? e('VARA_PUBLIC_HOST')
  let publicHost: string | undefined
  if (publicHostRaw) {
    publicHost = publicHostRaw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    if (!validHostName(publicHost)) throw new Error(`--public-host must be a DNS name such as vara.example.com (no port, no path); got "${publicHostRaw}"`)
  }

  const cwd = resolve(flag(args, '--cwd') ?? e('VARA_CWD') ?? opts.cwd ?? process.cwd())

  const logText = (flag(args, '--log') ?? e('VARA_LOG') ?? (e('JOURNAL_STREAM') && opts.daemon ? 'journal' : 'text')).toLowerCase()
  if (logText !== 'text' && logText !== 'json' && logText !== 'journal') throw new Error('--log must be text, json or journal')

  const tokenFlag = flag(args, '--token')
  const tokenFileFlag = flag(args, '--token-file')
  const tokenEnv = e('VARA_OWNER_TOKEN')
  const tokenFileEnv = e('VARA_OWNER_TOKEN_FILE')
  if (args.includes('--token') && tokenFlag === undefined) throw new Error('--token needs a value (better: --token-file <path> or VARA_OWNER_TOKEN)')
  if (args.includes('--token-file') && tokenFileFlag === undefined) throw new Error('--token-file needs a path')
  // A flag overrides the environment; two flags, or two environment variables, are ambiguous.
  if ((tokenFlag && tokenFileFlag) || (tokenEnv && tokenFileEnv && !tokenFlag && !tokenFileFlag)) throw new Error('give the owner token ONE way: --token-file, --token, VARA_OWNER_TOKEN_FILE or VARA_OWNER_TOKEN')

  let tokenFrom: ServeSettings['tokenFrom'] = 'persisted'
  let token: string | undefined
  let tokenFile: string | undefined
  if (tokenFileFlag) (tokenFile = resolve(tokenFileFlag)), (tokenFrom = 'file')
  else if (tokenFlag) {
    token = tokenFlag
    tokenFrom = 'flag'
    warnings.push('--token puts the secret in the process list and your shell history; prefer --token-file or VARA_OWNER_TOKEN_FILE.')
  } else if (tokenFileEnv) (tokenFile = resolve(tokenFileEnv)), (tokenFrom = 'env-file')
  else if (tokenEnv) {
    token = tokenEnv
    tokenFrom = 'env'
  }
  if (token !== undefined) {
    const problem = tokenProblem(token)
    if (problem) throw new Error(problem)
  }

  const rotateToken = args.includes('--rotate-token')
  if (rotateToken && (token !== undefined || tokenFile)) throw new Error('--rotate-token only applies to the generated token; you provided your own (change it where you keep it)')
  if (!opts.daemon && (token !== undefined || tokenFile || rotateToken)) throw new Error('an owner token is for `vara serve`; `vara ui` makes a fresh one every run')

  const trustProxy = args.includes('--trust-proxy') || truthy(e('VARA_TRUST_PROXY'))

  if (!isLoopback(bind)) {
    warnings.push(
      `listening on ${bind}: anyone who can reach port ${port} can try to log in. The owner token is required, but this is plain HTTP — put a TLS reverse proxy in front (docs/DEPLOYMENT.md), bind to 127.0.0.1 behind it, or publish the port only to a network you trust.`,
    )
    if (!publicHost) warnings.push('no --public-host: browsers must reach this host by an IP address on a private network (a domain name is refused until you set --public-host).')
  }
  if (publicHost && !trustProxy) warnings.push('--public-host without --trust-proxy: behind a reverse proxy every visitor looks like the proxy, so failed logins are counted together. Add --trust-proxy once your proxy sets X-Forwarded-For.')
  if (trustProxy && !isLoopback(bind)) warnings.push('--trust-proxy on a public bind: X-Forwarded-For can be forged by anyone who reaches the port directly. Only use it when the proxy is the ONLY way in (bind 127.0.0.1, or a firewall).')

  return { port, bind, ...(publicHost ? { publicHost } : {}), cwd, ...(token !== undefined ? { token } : {}), ...(tokenFile ? { tokenFile } : {}), tokenFrom, rotateToken, log: logText, trustProxy, daemon: opts.daemon, warnings }
}

/* ---------------- the owner token ---------------- */

export const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest()

/** Constant-time comparison of a presented token against a stored digest. */
export function tokenMatches(presented: string, digest: Buffer): boolean {
  return presented.length > 0 && timingSafeEqual(sha256(presented), digest)
}

export const newToken = (): string => randomBytes(32).toString('base64url')

export interface OwnerAuth {
  /** What the server compares against. The token itself is never kept after start. */
  digest: Buffer
  source: 'generated' | 'persisted' | 'provided'
  /** Set ONLY when the token was generated just now: it is shown once, and cannot be recovered afterwards. */
  oneTimeToken?: string
  /** Where a provided token came from / where the persisted digest is. */
  where: string
  warnings: string[]
}

export const ownerDigestFile = (hostDir: string): string => join(hostDir, 'owner-token.sha256')

function fileModeWarning(path: string, what: string): string | null {
  if (process.platform === 'win32') return null
  try {
    const mode = statSync(path).mode & 0o777
    if (mode & 0o077) return `${what} ${path} is readable by other users (mode ${mode.toString(8)}); run: chmod 600 ${path}`
  } catch {
    /* unreadable: the caller reports it */
  }
  return null
}

/**
 * The owner's credential for a headless host, in this order:
 *  1. a token the operator provides (`--token-file`, `VARA_OWNER_TOKEN_FILE`, `VARA_OWNER_TOKEN`, `--token`);
 *  2. the digest saved by an earlier start (only the SHA-256 is stored, mode 0600: the token cannot be read back);
 *  3. a new random token — returned ONCE so it can be printed, and only its digest is saved.
 * `rotate` discards the saved digest and makes a new token.
 */
export function resolveOwnerAuth(settings: Pick<ServeSettings, 'token' | 'tokenFile' | 'rotateToken'>, hostDir: string): OwnerAuth {
  const warnings: string[] = []
  if (settings.tokenFile) {
    let text: string
    try {
      text = readFileSync(settings.tokenFile, 'utf8')
    } catch (err) {
      throw new Error(`cannot read the owner token file ${settings.tokenFile}: ${(err as NodeJS.ErrnoException).code ?? (err as Error).message}`)
    }
    const token = text.replace(/^﻿/, '').trim()
    const problem = tokenProblem(token)
    if (problem) throw new Error(`${settings.tokenFile}: ${problem}`)
    const w = fileModeWarning(settings.tokenFile, 'the token file')
    if (w) warnings.push(w)
    return { digest: sha256(token), source: 'provided', where: settings.tokenFile, warnings }
  }
  if (settings.token !== undefined) return { digest: sha256(settings.token), source: 'provided', where: 'the environment / command line', warnings }

  const file = ownerDigestFile(hostDir)
  if (!settings.rotateToken && existsSync(file)) {
    try {
      const data = JSON.parse(readFileSync(file, 'utf8')) as { sha256?: string }
      if (typeof data.sha256 === 'string' && /^[0-9a-f]{64}$/.test(data.sha256)) {
        const w = fileModeWarning(file, 'the saved owner token')
        if (w) warnings.push(w)
        return { digest: Buffer.from(data.sha256, 'hex'), source: 'persisted', where: file, warnings }
      }
    } catch {
      /* damaged: fall through and make a new one, loudly */
    }
    warnings.push(`${file} was unreadable, so a new owner token was made (the old one no longer works).`)
  }
  const token = newToken()
  mkdirSync(hostDir, { recursive: true, mode: 0o700 })
  writeFileSync(file, JSON.stringify({ sha256: sha256(token).toString('hex'), createdAt: new Date().toISOString() }), { mode: 0o600 })
  try {
    chmodSync(file, 0o600)
  } catch {
    /* Windows: the folder's own permissions apply */
  }
  return { digest: sha256(token), source: 'generated', oneTimeToken: token, where: file, warnings }
}

/* ---------------- logging ---------------- */

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void
  warn(msg: string, extra?: Record<string, unknown>): void
  error(msg: string, extra?: Record<string, unknown>): void
  /** A line that must be shown exactly as it is (the one-time URL), in every mode. */
  raw(text: string): void
}

const SYSLOG = { info: 6, warn: 4, error: 3 } as const

/**
 * `text`: readable lines. `journal`: the same lines with a syslog priority prefix (`<6>`), which journald turns
 * into the right severity without any parsing rules, and no timestamp (journald adds its own). `json`: one JSON
 * object per line for log shippers and containers.
 */
export function makeLogger(mode: LogMode, write: (line: string) => void = (l) => process.stdout.write(`${l}\n`), now: () => Date = () => new Date()): Logger {
  const line = (level: keyof typeof SYSLOG, msg: string, extra?: Record<string, unknown>): void => {
    const clean = msg.replace(/\r?\n/g, ' ')
    if (mode === 'json') return write(JSON.stringify({ ts: now().toISOString(), level, msg: clean, ...extra }))
    const tail = extra && Object.keys(extra).length ? ` ${Object.entries(extra).map(([k, v]) => `${k}=${String(v)}`).join(' ')}` : ''
    if (mode === 'journal') return write(`<${SYSLOG[level]}>${clean}${tail}`)
    write(`${now().toISOString()} ${level.toUpperCase().padEnd(5)} ${clean}${tail}`)
  }
  return {
    info: (m, e) => line('info', m, e),
    warn: (m, e) => line('warn', m, e),
    error: (m, e) => line('error', m, e),
    raw: (text) => {
      if (mode === 'json') return write(JSON.stringify({ ts: now().toISOString(), level: 'info', msg: text.replace(/\r?\n/g, ' ') }))
      write(mode === 'journal' ? `<6>${text.replace(/\r?\n/g, ' ')}` : text)
    },
  }
}

/* ---------------- shutdown ---------------- */

export interface ShutdownSteps {
  /** Named, in order. A step that throws or hangs must not stop the next ones. */
  steps: Array<{ name: string; run: () => Promise<unknown> | unknown }>
  log: Logger
  /** Give up waiting for one step after this long. */
  stepTimeoutMs?: number
}

/**
 * Build the one function that stops the host. Asking twice is harmless (the second call returns the first
 * call's promise); every step is attempted even if an earlier one failed or hung; the result says whether the
 * stop was clean.
 */
export function makeShutdown(opts: ShutdownSteps): (reason: string) => Promise<{ clean: boolean }> {
  let running: Promise<{ clean: boolean }> | null = null
  const limit = opts.stepTimeoutMs ?? 8_000
  return (reason) => {
    if (running) return running
    running = (async () => {
      opts.log.info(`stopping: ${reason}`)
      let clean = true
      for (const step of opts.steps) {
        let timer: NodeJS.Timeout | undefined
        try {
          await Promise.race([
            Promise.resolve().then(step.run),
            new Promise((_, reject) => {
              timer = setTimeout(() => reject(new Error(`timed out after ${limit} ms`)), limit)
              timer.unref?.()
            }),
          ])
        } catch (err) {
          clean = false
          opts.log.warn(`shutdown step "${step.name}" failed: ${(err as Error).message}`)
        } finally {
          if (timer) clearTimeout(timer)
        }
      }
      opts.log.info(clean ? 'stopped' : 'stopped with problems')
      return { clean }
    })()
    return running
  }
}
