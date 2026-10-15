import { decodeEntities, stripTags } from './extract.js'
import { safeRequest, WebError, type HttpOptions, type HttpResponse } from './http.js'

export type Recency = 'day' | 'week' | 'month' | 'year'

export interface SearchQuery {
  query: string
  max: number
  recency?: Recency
  /** Two-letter country code, e.g. "us", "fr", "tn". */
  region?: string
  /** Two-letter language code, e.g. "en", "ar". */
  language?: string
}

export interface WebResult {
  title: string
  url: string
  snippet: string
}

export interface SearchProvider {
  id: string
  /** True when this provider honours the recency filter. */
  recency: boolean
  search(q: SearchQuery): Promise<WebResult[]>
}

/** How providers talk to the network. Replaced in tests; the real one is `safeRequest` (own machine, own IP). */
export type Http = (url: string, opts?: HttpOptions) => Promise<HttpResponse>
export const realHttp: Http = safeRequest

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

function ok(r: HttpResponse, who: string): string {
  if (r.status === 429 || r.status === 403 || r.status === 202 || r.status === 503) throw new WebError(`${who} refused this request (HTTP ${r.status}): it looks like rate limiting or bot protection`, 'blocked')
  if (r.status >= 400) throw new WebError(`${who} answered HTTP ${r.status}`, 'http')
  return r.body
}

function clean(list: WebResult[], max: number): WebResult[] {
  const seen = new Set<string>()
  const out: WebResult[] = []
  for (const r of list) {
    let u: URL
    try {
      u = new URL(r.url)
    } catch {
      continue
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    u.hash = ''
    const key = u.toString()
    if (seen.has(key) || !r.title) continue
    seen.add(key)
    out.push({ title: clip(r.title, 160), url: key, snippet: clip(r.snippet, 400) })
    if (out.length >= max) break
  }
  return out
}

/* ---------- DuckDuckGo (HTML endpoint, no key) ---------- */

/** DuckDuckGo wraps result links in `//duckduckgo.com/l/?uddg=<real url>`. */
export function unwrapDdg(href: string): string {
  const h = decodeEntities(href)
  const m = /[?&]uddg=([^&]+)/.exec(h)
  if (m) {
    try {
      return decodeURIComponent(m[1]!)
    } catch {
      return ''
    }
  }
  return h.startsWith('//') ? `https:${h}` : h
}

export function parseDuckDuckGo(html: string, max: number): WebResult[] {
  if (/anomaly-modal|g-recaptcha|Unfortunately, bots use DuckDuckGo too/i.test(html)) throw new WebError('DuckDuckGo showed a bot check instead of results', 'blocked')
  const out: WebResult[] = []
  const re = /<a\b[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*class="[^"]*\bresult__a\b|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const snip = /<(?:a|div|td)\b[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/i.exec(m[3]!)
    out.push({ title: stripTags(m[2]!), url: unwrapDdg(m[1]!), snippet: snip ? stripTags(snip[1]!) : '' })
  }
  return clean(out.filter((r) => !/duckduckgo\.com\/y\.js/.test(r.url)), max)
}

export function duckduckgo(http: Http = realHttp, base = 'https://html.duckduckgo.com', extra: HttpOptions = {}): SearchProvider {
  return {
    id: 'duckduckgo',
    recency: true,
    async search(q) {
      const p = new URLSearchParams({ q: q.query, kl: q.region && q.language ? `${q.region.toLowerCase()}-${q.language.toLowerCase()}` : 'wt-wt' })
      if (q.recency) p.set('df', { day: 'd', week: 'w', month: 'm', year: 'y' }[q.recency])
      const html = ok(await http(`${base}/html/?${p}`, extra), 'DuckDuckGo')
      return parseDuckDuckGo(html, q.max)
    },
  }
}

/* ---------- Mojeek (own index, plain HTML, no key) ---------- */

export function parseMojeek(html: string, max: number): WebResult[] {
  const out: WebResult[] = []
  const re = /<a\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*href="(https?:[^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=<a\b[^>]*class="[^"]*\btitle\b|$)/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html))) {
    const snip = /<p\b[^>]*class="[^"]*\bs\b[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(m[3]!)
    out.push({ title: stripTags(m[2]!), url: decodeEntities(m[1]!), snippet: snip ? stripTags(snip[1]!) : '' })
  }
  return clean(out, max)
}

export function mojeek(http: Http = realHttp, base = 'https://www.mojeek.com', extra: HttpOptions = {}): SearchProvider {
  return {
    id: 'mojeek',
    recency: false,
    async search(q) {
      const p = new URLSearchParams({ q: q.query })
      if (q.language) p.set('lb', q.language.toLowerCase())
      if (q.region) p.set('arc', q.region.toLowerCase())
      const html = ok(await http(`${base}/search?${p}`, extra), 'Mojeek')
      return parseMojeek(html, q.max)
    },
  }
}

/* ---------- SearXNG (community instances; JSON output) ---------- */

export function searxng(instances: string[], http: Http = realHttp, extra: HttpOptions = {}): SearchProvider {
  return {
    id: 'searxng',
    recency: true,
    async search(q) {
      if (!instances.length) throw new WebError('no SearXNG instance is configured', 'other')
      const errors: string[] = []
      // A few instances, in random order, so no single community server takes all the load.
      const order = [...instances].sort(() => Math.random() - 0.5).slice(0, 3)
      for (const inst of order) {
        try {
          const p = new URLSearchParams({ q: q.query, format: 'json', safesearch: '0' })
          if (q.recency) p.set('time_range', q.recency)
          if (q.language) p.set('language', q.language.toLowerCase())
          const body = ok(await http(`${inst.replace(/\/+$/, '')}/search?${p}`, { ...extra, headers: { accept: 'application/json' } }), inst)
          const data = JSON.parse(body) as { results?: Array<{ title?: string; url?: string; content?: string }> }
          const r = clean((data.results ?? []).map((x) => ({ title: stripTags(x.title ?? ''), url: x.url ?? '', snippet: stripTags(x.content ?? '') })), q.max)
          if (r.length) return r
          errors.push(`${inst}: no results`)
        } catch (e) {
          errors.push(`${inst}: ${(e as Error).message}`)
        }
      }
      throw new WebError(`no SearXNG instance answered (${errors.join('; ')})`, 'blocked')
    },
  }
}

/* ---------- Optional API providers: only when the owner stored a key; never required ---------- */

const RECENCY = { day: 'd', week: 'w', month: 'm', year: 'y' } as const

export function brave(key: string, http: Http = realHttp, base = 'https://api.search.brave.com', extra: HttpOptions = {}): SearchProvider {
  return {
    id: 'brave',
    recency: true,
    async search(q) {
      const p = new URLSearchParams({ q: q.query, count: String(Math.min(q.max, 20)) })
      if (q.recency) p.set('freshness', `p${RECENCY[q.recency]}`)
      if (q.region) p.set('country', q.region.toLowerCase())
      if (q.language) p.set('search_lang', q.language.toLowerCase())
      const body = ok(await http(`${base}/res/v1/web/search?${p}`, { ...extra, headers: { 'x-subscription-token': key, accept: 'application/json' } }), 'Brave Search')
      const data = JSON.parse(body) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } }
      return clean((data.web?.results ?? []).map((x) => ({ title: stripTags(x.title ?? ''), url: x.url ?? '', snippet: stripTags(x.description ?? '') })), q.max)
    },
  }
}

export function tavily(key: string, http: Http = realHttp, base = 'https://api.tavily.com', extra: HttpOptions = {}): SearchProvider {
  return {
    id: 'tavily',
    recency: true,
    async search(q) {
      const payload: Record<string, unknown> = { query: q.query, max_results: Math.min(q.max, 20) }
      if (q.recency) payload['time_range'] = q.recency
      const body = ok(await http(`${base}/search`, { ...extra, method: 'POST', body: JSON.stringify(payload), headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' } }), 'Tavily')
      const data = JSON.parse(body) as { results?: Array<{ title?: string; url?: string; content?: string }> }
      return clean((data.results ?? []).map((x) => ({ title: stripTags(x.title ?? ''), url: x.url ?? '', snippet: stripTags(x.content ?? '') })), q.max)
    },
  }
}

export function serper(key: string, http: Http = realHttp, base = 'https://google.serper.dev', extra: HttpOptions = {}): SearchProvider {
  return {
    id: 'serper',
    recency: true,
    async search(q) {
      const payload: Record<string, unknown> = { q: q.query, num: Math.min(q.max, 20) }
      if (q.recency) payload['tbs'] = `qdr:${RECENCY[q.recency]}`
      if (q.region) payload['gl'] = q.region.toLowerCase()
      if (q.language) payload['hl'] = q.language.toLowerCase()
      const body = ok(await http(`${base}/search`, { ...extra, method: 'POST', body: JSON.stringify(payload), headers: { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json' } }), 'Serper')
      const data = JSON.parse(body) as { organic?: Array<{ title?: string; link?: string; snippet?: string }> }
      return clean((data.organic ?? []).map((x) => ({ title: stripTags(x.title ?? ''), url: x.link ?? '', snippet: stripTags(x.snippet ?? '') })), q.max)
    },
  }
}
