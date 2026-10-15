import { capText, readableFromHtml } from './extract.js'
import { WebError } from './http.js'
import { realHttp, type Http, type SearchProvider, type SearchQuery, type WebResult } from './providers.js'

/** A small in-memory TTL cache (per process). Keeps repeat questions free and polite to the search sites. */
export class TtlCache<V> {
  private readonly m = new Map<string, { at: number; v: V }>()
  constructor(
    private readonly ttlMs: number,
    private readonly max = 100,
  ) {}
  get(k: string, now = Date.now()): V | undefined {
    const e = this.m.get(k)
    if (!e) return undefined
    if (now - e.at > this.ttlMs) {
      this.m.delete(k)
      return undefined
    }
    return e.v
  }
  set(k: string, v: V, now = Date.now()): void {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string)
    this.m.set(k, { at: now, v })
  }
  clear(): void {
    this.m.clear()
  }
}

/** At most `limit` calls in any sliding minute. */
export class RateLimiter {
  private readonly hits: number[] = []
  constructor(private limit: number) {}
  setLimit(n: number): void {
    this.limit = n
  }
  /** Returns seconds to wait when over the limit, else 0 (and records the call). */
  take(now = Date.now()): number {
    while (this.hits.length && now - this.hits[0]! > 60_000) this.hits.shift()
    if (this.hits.length >= this.limit) return Math.ceil((60_000 - (now - this.hits[0]!)) / 1000)
    this.hits.push(now)
    return 0
  }
}

export interface ChainResult {
  provider: string
  results: WebResult[]
  recencyApplied: boolean
  cached: boolean
  /** Providers that failed before one answered, with why. */
  skipped: string[]
}

/** Try each provider in order; the first that returns results wins. All failing → one clear error. */
export async function searchChain(providers: SearchProvider[], q: SearchQuery): Promise<Omit<ChainResult, 'cached'>> {
  if (!providers.length) throw new WebError('no search provider is available (check agent web search settings)', 'other')
  const skipped: string[] = []
  let empty = false
  let allOffline = true
  for (const p of providers) {
    try {
      const results = await p.search(q)
      if (results.length) return { provider: p.id, results, recencyApplied: !!q.recency && p.recency, skipped }
      empty = true
      allOffline = false
      skipped.push(`${p.id}: no results`)
    } catch (e) {
      const err = e as WebError
      if (err.kind !== 'offline') allOffline = false
      skipped.push(`${p.id}: ${err.message}`)
    }
  }
  if (empty) return { provider: providers[0]!.id, results: [], recencyApplied: false, skipped }
  throw new WebError(
    allOffline
      ? `Could not reach any search site from this machine: you may be offline, or a firewall/DNS filter blocks them. (${skipped.join(' | ')})`
      : `Every search provider failed or was blocked from this machine: ${skipped.join(' | ')}. Try again later, enable the browser tool, or ask the owner to store a Brave/Tavily/Serper key.`,
    allOffline ? 'offline' : 'blocked',
  )
}

export interface PageText {
  url: string
  title: string
  robots: string
  text: string
  end: number
  total: number
  truncatedDownload: boolean
}

const TEXTUAL = /^(text\/|application\/(json|xml|xhtml\+xml|ld\+json|rss\+xml|atom\+xml)|$)/i

/** Download one page and reduce it to readable text. Refuses anything that is not text (no file downloads). */
export async function fetchPage(url: string, o: { http?: Http; start?: number; maxChars: number; maxBytes?: number }): Promise<PageText> {
  const http = o.http ?? realHttp
  const r = await http(url, { maxBytes: o.maxBytes ?? 1_500_000 })
  if (r.status === 404 || r.status === 410) throw new WebError(`${r.url} does not exist (HTTP ${r.status})`, 'http')
  if (r.status === 401 || r.status === 403 || r.status === 429) throw new WebError(`${r.url} refused the request (HTTP ${r.status}); it may need a login or block automated readers`, 'blocked')
  if (r.status >= 400) throw new WebError(`${r.url} answered HTTP ${r.status}`, 'http')
  const ct = r.contentType.split(';')[0]!.trim()
  if (!TEXTUAL.test(ct)) throw new WebError(`Not read: ${r.url} is ${ct || 'an unknown type'}, not text (VARA does not download files here)`, 'type')
  const isHtml = /html/i.test(ct) || (ct === '' && /<html|<body|<!doctype/i.test(r.body.slice(0, 500)))
  const page = isHtml ? readableFromHtml(r.body) : { title: '', text: r.body.trim(), robots: '' }
  const cap = capText(page.text, o.start ?? 0, o.maxChars)
  return { url: r.url, title: page.title, robots: page.robots, text: cap.text, end: cap.end, total: cap.total, truncatedDownload: r.truncated }
}
