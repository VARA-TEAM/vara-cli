/** Turning HTML into the small amount of text a model should read. Pure and dependency-free. */

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', laquo: '«', raquo: '»', copy: '©', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' }

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m
    }
    return NAMED[e.toLowerCase()] ?? m
  })
}

/** Tags removed together with everything inside them. */
const DROP = ['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'canvas', 'form', 'nav', 'footer', 'aside', 'select', 'button', 'dialog']

function inner(html: string, tag: string): string | null {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'i').exec(html)
  return m ? m[1]! : null
}

export function stripTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

export interface Readable {
  title: string
  text: string
  /** The page's own `<meta name="robots">` value, if any. Only a hint for the model; reading is never blocked by it. */
  robots: string
}

export function readableFromHtml(html: string): Readable {
  const title = stripTags(inner(html, 'title') ?? '')
  const robotsTag = /<meta\b[^>]*name\s*=\s*["']?robots["']?[^>]*>/i.exec(html)?.[0] ?? ''
  const robots = /content\s*=\s*["']([^"']*)["']/i.exec(robotsTag)?.[1]?.toLowerCase().trim() ?? ''
  let h = html.replace(/<!--[\s\S]*?-->/g, ' ')
  for (const t of DROP) h = h.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?</${t}>`, 'gi'), ' ')
  // The page's header usually holds the site menu; a header INSIDE an article/main is kept (it carries the headline).
  const body = inner(h, 'main') ?? inner(h, 'article') ?? inner(h, 'body') ?? h
  const scoped = stripTags(body).length > 200 ? body : (inner(h, 'body') ?? h)
  const cleaned = scoped.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, (m) => (/<h1\b/i.test(m) ? m : ' '))
  const text = decodeEntities(
    cleaned
      .replace(/<h([1-6])\b[^>]*>/gi, (_m, n: string) => `\n\n${'#'.repeat(Number(n))} `)
      .replace(/<li\b[^>]*>/gi, '\n- ')
      .replace(/<(br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/(p|div|section|article|tr|table|ul|ol|h[1-6]|blockquote|pre|figure|figcaption)>/gi, '\n')
      .replace(/<(p|div|section|article|tr|blockquote|pre)\b[^>]*>/gi, '\n')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/[ \t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { title, text, robots }
}

/** Keep at most `max` characters, cutting at a paragraph or sentence edge when one is near. */
export function capText(text: string, start: number, max: number): { text: string; end: number; total: number } {
  const total = text.length
  const from = Math.min(Math.max(0, start), total)
  let to = Math.min(total, from + max)
  if (to < total) {
    const window = text.slice(from, to)
    const cut = Math.max(window.lastIndexOf('\n\n'), window.lastIndexOf('. '))
    if (cut > max * 0.6) to = from + cut + 1
  }
  return { text: text.slice(from, to).trim(), end: to, total }
}
