/**
 * Small markdown parser for assistant replies — pure, DOM-free, never produces HTML
 * (the renderer builds React elements, so nothing a model writes can inject markup).
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'strong'; c: Inline[] }
  | { t: 'em'; c: Inline[] }
  | { t: 'del'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }

export interface ListItem {
  c: Inline[]
  children: Block[]
}

export type Block =
  | { t: 'p'; c: Inline[] }
  | { t: 'h'; level: number; c: Inline[] }
  | { t: 'list'; ordered: boolean; start: number; items: ListItem[] }
  | { t: 'quote'; blocks: Block[] }
  | { t: 'code'; lang: string; v: string }
  | { t: 'hr' }
  | { t: 'table'; head: Inline[][]; rows: Inline[][][]; align: Array<'left' | 'right' | 'center' | null> }

/** Only web and mail links are ever clickable. */
export function safeHref(href: string): string | null {
  return /^(https?:\/\/|mailto:)/i.test(href.trim()) ? href.trim() : null
}

const INLINE_RULES: Array<{ re: RegExp; make: (m: RegExpExecArray) => Inline | null }> = [
  { re: /`([^`\n]+)`/y, make: (m) => ({ t: 'code', v: m[1]! }) },
  { re: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/y, make: (m) => ({ t: 'strong', c: parseInline(m[1]!) }) },
  { re: /__(?=\S)([\s\S]+?)(?<=\S)__/y, make: (m) => ({ t: 'strong', c: parseInline(m[1]!) }) },
  { re: /~~(?=\S)([\s\S]+?)(?<=\S)~~/y, make: (m) => ({ t: 'del', c: parseInline(m[1]!) }) },
  { re: /\*(?=[^\s*])([^*\n]+?)(?<=[^\s*])\*/y, make: (m) => ({ t: 'em', c: parseInline(m[1]!) }) },
  { re: /(?<![\w])_(?=[^\s_])([^_\n]+?)(?<=[^\s_])_(?![\w])/y, make: (m) => ({ t: 'em', c: parseInline(m[1]!) }) },
  {
    re: /\[([^\]\n]+)\]\(([^)\s]+)\)/y,
    make: (m) => {
      const href = safeHref(m[2]!)
      return href ? { t: 'link', href, c: parseInline(m[1]!) } : { t: 'text', v: m[1]! }
    },
  },
  { re: /https?:\/\/[^\s<>)\]]+[^\s<>)\].,;:!?]/y, make: (m) => ({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] }) },
]

export function parseInline(src: string): Inline[] {
  const out: Inline[] = []
  let text = ''
  const flush = (): void => {
    if (text) out.push({ t: 'text', v: text })
    text = ''
  }
  let i = 0
  scan: while (i < src.length) {
    const ch = src[i]!
    // Only try the (cheap) rules where a construct can start.
    if (ch === '`' || ch === '*' || ch === '_' || ch === '~' || ch === '[' || ch === 'h') {
      for (const rule of INLINE_RULES) {
        rule.re.lastIndex = i
        const m = rule.re.exec(src)
        if (m && m.index === i) {
          const node = rule.make(m)
          if (node) {
            flush()
            out.push(node)
            i += m[0].length
            continue scan
          }
        }
      }
    }
    // Backslash escapes: \* \_ \` …
    if (ch === '\\' && i + 1 < src.length && /[\\`*_{}[\]()#+\-.!~|>]/.test(src[i + 1]!)) {
      text += src[i + 1]
      i += 2
      continue
    }
    text += ch
    i++
  }
  flush()
  return out
}

const isFence = (l: string): RegExpExecArray | null => /^\s*(```+|~~~+)\s*([\w+#.-]*)\s*$/.exec(l)
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/

function splitRow(line: string): string[] {
  let s = line.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'))
}

export function parseBlocks(text: string): Block[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  return parseLines(lines)
}

function parseLines(lines: string[]): Block[] {
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    if (!line.trim()) {
      i++
      continue
    }
    // fenced code
    const fence = isFence(line)
    if (fence) {
      const marker = fence[1]![0]!
      const body: string[] = []
      i++
      while (i < lines.length && !new RegExp(`^\\s*${marker}{3,}\\s*$`).test(lines[i]!)) body.push(lines[i++]!)
      i++ // closing fence (or end of a still-streaming block)
      blocks.push({ t: 'code', lang: fence[2] ?? '', v: body.join('\n') })
      continue
    }
    // heading
    const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line)
    if (h) {
      blocks.push({ t: 'h', level: h[1]!.length, c: parseInline(h[2]!) })
      i++
      continue
    }
    // rule
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push({ t: 'hr' })
      i++
      continue
    }
    // table: header row + separator row
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1]!)) {
      const head = splitRow(line)
      const align = splitRow(lines[i + 1]!).map((c) => (/^:-+:$/.test(c) ? 'center' : /^-+:$/.test(c) ? 'right' : /^:-+$/.test(c) ? 'left' : null))
      i += 2
      const rows: string[][] = []
      while (i < lines.length && lines[i]!.trim() && lines[i]!.includes('|')) rows.push(splitRow(lines[i++]!))
      blocks.push({ t: 'table', head: head.map(parseInline), rows: rows.map((r) => r.map(parseInline)), align })
      continue
    }
    // blockquote
    if (/^\s*>/.test(line)) {
      const inner: string[] = []
      while (i < lines.length && /^\s*>/.test(lines[i]!)) inner.push(lines[i++]!.replace(/^\s*>\s?/, ''))
      blocks.push({ t: 'quote', blocks: parseLines(inner) })
      continue
    }
    // list (with nesting by indentation)
    if (LIST_RE.test(line)) {
      const start = i
      while (i < lines.length && (LIST_RE.test(lines[i]!) || (/^\s{2,}\S/.test(lines[i]!) && i > start) )) i++
      blocks.push(parseList(lines.slice(start, i)))
      continue
    }
    // paragraph: until a blank line or the start of another block
    const para: string[] = []
    while (i < lines.length && lines[i]!.trim() && !isFence(lines[i]!) && !/^(#{1,6})\s/.test(lines[i]!) && !LIST_RE.test(lines[i]!) && !/^\s*>/.test(lines[i]!)) para.push(lines[i++]!)
    if (!para.length) {
      para.push(lines[i++]!)
    }
    blocks.push({ t: 'p', c: parseInline(para.map((l) => l.trim()).join('\n')) })
  }
  return blocks
}

function parseList(lines: string[]): Block {
  const first = LIST_RE.exec(lines[0]!)!
  const baseIndent = first[1]!.length
  const ordered = /\d/.test(first[2]!)
  const items: ListItem[] = []
  let current: { text: string; rest: string[] } | null = null
  const close = (): void => {
    if (!current) return
    items.push({ c: parseInline(current.text), children: current.rest.length ? parseLines(dedent(current.rest)) : [] })
    current = null
  }
  for (const line of lines) {
    const m = LIST_RE.exec(line)
    if (m && m[1]!.length <= baseIndent) {
      close()
      current = { text: m[3]!, rest: [] }
    } else if (current) {
      current.rest.push(line)
    }
  }
  close()
  return { t: 'list', ordered, start: ordered ? Number.parseInt(first[2]!, 10) || 1 : 1, items }
}

function dedent(lines: string[]): string[] {
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)![0].length)
  const cut = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(Math.min(cut, /^\s*/.exec(l)![0].length)))
}
