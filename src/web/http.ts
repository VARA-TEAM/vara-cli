import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { isIP } from 'node:net'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import { isLoopback, isPrivateHost, OriginPolicy } from '../browser/policy.js'
import { VERSION } from '../version.js'

/** An honest user agent: sites can see exactly what is asking, and block it if they wish. */
export const USER_AGENT = `VARA/${VERSION} (+https://github.com/VARA-TEAM/vara-cli; terminal coding agent, read-only web lookup on behalf of its user)`

export interface HttpOptions {
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  /** Tests only: the fake server lives on 127.0.0.1. Never set by the tools. */
  allowLoopback?: boolean
  signal?: AbortSignal
}

export interface HttpResponse {
  status: number
  /** The address finally read, after redirects. */
  url: string
  contentType: string
  body: string
  truncated: boolean
}

export class WebError extends Error {
  constructor(
    message: string,
    readonly kind: 'blocked' | 'offline' | 'http' | 'type' | 'timeout' | 'other' = 'other',
  ) {
    super(message)
  }
}

/** Strip the IPv4-mapped IPv6 prefix so `::ffff:10.0.0.1` is judged as 10.0.0.1. */
function plainAddress(a: string): string {
  return a.toLowerCase().replace(/^::ffff:/, '')
}

/** Is a RESOLVED address one the agent may not reach? (Catches DNS names that point inside the user's network.) */
export function addressRefused(address: string, allowLoopback: boolean): string | null {
  const a = plainAddress(address)
  if (isLoopback(a) || a === '::' || a === '0.0.0.0') return allowLoopback ? null : `${a} is this machine itself`
  if (isPrivateHost(a)) return `${a} is on a private network or is a metadata address`
  return null
}

function hostOfUrl(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/**
 * One safe GET/POST:
 *  - http/https only; every hop (including redirects) goes through the browser OriginPolicy and its deny-list;
 *  - the connection uses a pinned lookup, so a name that resolves to a private address is refused AT CONNECT TIME
 *    (no check-then-connect gap for DNS rebinding);
 *  - time and size limits, at most `maxRedirects` redirects, no cookies, API keys never forwarded to another host.
 */
export async function safeRequest(rawUrl: string, opts: HttpOptions = {}): Promise<HttpResponse> {
  const maxBytes = opts.maxBytes ?? 1_500_000
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxRedirects = opts.maxRedirects ?? 5
  const policy = new OriginPolicy()
  let url = rawUrl
  let method = opts.method ?? 'GET'
  let body = opts.body
  const first = hostOfUrl(rawUrl)
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const host = hostOfUrl(url) ?? ''
    const verdict = policy.check(url)
    if (isLoopback(host)) {
      if (!opts.allowLoopback) throw new WebError('Not fetched: that address is this machine itself (use the browser tool for local development servers)', 'blocked')
    } else if (verdict.kind === 'deny') throw new WebError(`Not fetched: ${verdict.reason}`, 'blocked')
    const headers = { ...(opts.headers ?? {}) }
    if (host !== first) for (const k of Object.keys(headers)) if (/^(authorization|x-api-key|x-subscription-token)$/i.test(k)) delete headers[k]
    const res = await once(url, method, headers, body, maxBytes, timeoutMs, !!opts.allowLoopback, opts.signal)
    if (res.status >= 300 && res.status < 400 && res.location) {
      let next: string
      try {
        next = new URL(res.location, url).toString()
      } catch {
        throw new WebError('The server sent a broken redirect', 'http')
      }
      url = next
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
        method = 'GET'
        body = undefined
      }
      continue
    }
    return { status: res.status, url, contentType: res.contentType, body: res.body, truncated: res.truncated }
  }
  throw new WebError(`Stopped after ${maxRedirects} redirects`, 'http')
}

interface Raw {
  status: number
  location?: string
  contentType: string
  body: string
  truncated: boolean
}

function once(url: string, method: string, headers: Record<string, string>, body: string | undefined, maxBytes: number, timeoutMs: number, allowLoopback: boolean, signal?: AbortSignal): Promise<Raw> {
  return new Promise<Raw>((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      return reject(new WebError('That is not a valid address', 'type'))
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return reject(new WebError('Only http and https addresses can be read', 'blocked'))
    const send = u.protocol === 'https:' ? httpsRequest : httpRequest
    // Pinned lookup: the address that passes the check is the address that is connected to.
    const lookup = (hostname: string, o: unknown, cb: (e: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
      const bare = hostname.replace(/^\[|\]$/g, '')
      const check = (list: LookupAddress[]) => {
        for (const a of list) {
          const why = addressRefused(a.address, allowLoopback)
          if (why) return cb(new WebError(`Not fetched: ${bare} resolves to ${why}`, 'blocked') as unknown as NodeJS.ErrnoException, '', 0)
        }
        const all = typeof o === 'object' && o !== null && (o as { all?: boolean }).all
        if (all) cb(null, list)
        else cb(null, list[0]!.address, list[0]!.family)
      }
      if (isIP(bare)) return check([{ address: bare, family: isIP(bare) }])
      dnsLookup(bare, { all: true }, (err, list) => (err ? cb(err, '', 0) : check(list)))
    }
    const timer = setTimeout(() => req.destroy(new WebError(`Timed out after ${Math.round(timeoutMs / 1000)}s`, 'timeout')), timeoutMs)
    const req = send(
      u,
      {
        method,
        headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1', 'accept-encoding': 'gzip, deflate, br', ...headers, ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
        lookup: lookup as never,
      },
      (res: IncomingMessage) => {
        const status = res.statusCode ?? 0
        const contentType = String(res.headers['content-type'] ?? '')
        const location = typeof res.headers['location'] === 'string' ? res.headers['location'] : undefined
        if (status >= 300 && status < 400 && location) {
          res.resume()
          clearTimeout(timer)
          return resolve({ status, location, contentType, body: '', truncated: false })
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase()
        const stream = enc.includes('br') ? res.pipe(createBrotliDecompress()) : enc.includes('gzip') ? res.pipe(createGunzip()) : enc.includes('deflate') ? res.pipe(createInflate()) : res
        const chunks: Buffer[] = []
        let size = 0
        let truncated = false
        let finished = false
        const done = () => {
          if (finished) return
          finished = true
          clearTimeout(timer)
          resolve({ status, contentType, body: Buffer.concat(chunks).toString('utf8'), truncated })
        }
        stream.on('data', (c: Buffer) => {
          if (truncated) return
          size += c.length
          if (size > maxBytes) {
            chunks.push(c.subarray(0, c.length - (size - maxBytes)))
            truncated = true
            res.destroy()
            done()
          } else chunks.push(c)
        })
        stream.on('end', done)
        stream.on('error', (e) => {
          if (truncated || finished) return
          finished = true
          clearTimeout(timer)
          reject(e)
        })
      },
    )
    req.on('error', (e) => {
      clearTimeout(timer)
      if (e instanceof WebError) return reject(e)
      const code = (e as NodeJS.ErrnoException).code
      const inner = (e as { cause?: unknown }).cause
      if (inner instanceof WebError) return reject(inner)
      if (e.message.startsWith('Not fetched:')) return reject(new WebError(e.message, 'blocked'))
      if (code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ECONNREFUSED' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH' || code === 'ECONNRESET') return reject(new WebError(`Could not reach ${u.hostname} (${code}). Offline, or blocked by a firewall or DNS filter?`, 'offline'))
      reject(new WebError(e.message, 'other'))
    })
    signal?.addEventListener('abort', () => req.destroy(new WebError('Cancelled', 'other')), { once: true })
    if (body !== undefined) req.write(body)
    req.end()
  })
}
