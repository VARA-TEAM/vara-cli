import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

/**
 * Tool-output economics.
 *
 * A command's output is the biggest single source of wasted tokens: a test run
 * prints thousands of lines, three of which matter. `compressToolOutput` keeps
 * what a reader needs (the start, the end, and every line that looks like an
 * error or a verdict), collapses repeats, and tells the model exactly how to
 * ask for the rest (`tool_output`). Nothing is lost: the full text is stored.
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
/** Lines worth keeping from the middle of a long output. */
const IMPORTANT = /error|fail|fatal|exception|panic|traceback|assert|denied|refused|timed out|timeout|cannot|can't|unable|not found|undefined|warn|deprecated|✗|✖|×|^\s*(?:E\s|at .+\(.+:\d+)|\bTS\d{4}\b|exit code|\bpassed\b|\btotal\b/i

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '')
}

/** Collapse runs of identical consecutive lines: `line` ×N. */
export function collapseRepeats(lines: string[]): string[] {
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    let j = i + 1
    while (j < lines.length && lines[j] === lines[i]) j++
    const n = j - i
    if (n >= 3 && lines[i]!.trim() !== '') out.push(`${lines[i]}  [x${n}]`)
    else for (let k = i; k < j; k++) out.push(lines[k]!)
    i = j
  }
  return out
}

export interface Compressed {
  text: string
  /** Characters of the original that the model will not see. */
  omittedChars: number
  fullLength: number
  compressed: boolean
}

/**
 * Fit `text` in `maxChars`. Output that already fits is returned as is (apart
 * from ANSI codes, which are noise to a model). The result is deterministic.
 */
export function compressToolOutput(text: string, maxChars: number, handle?: string): Compressed {
  const clean = stripAnsi(text)
  const fullLength = text.length
  if (clean.length <= maxChars) return { text: clean, omittedChars: Math.max(0, fullLength - clean.length), fullLength, compressed: false }

  const lines = collapseRepeats(clean.split('\n'))
  const joined = lines.join('\n')
  const hint = (shown: number, omitted: number) =>
    `[output compressed: ${omitted} of ${lines.length} lines left out${handle ? `; the full text is saved — call tool_output with id "${handle}" (head, tail, grep, from/to)` : ''}]`
  if (joined.length <= maxChars) {
    return { text: joined, omittedChars: fullLength - joined.length, fullLength, compressed: joined.length < fullLength }
  }

  const reserve = 200 // for the markers
  const budget = Math.max(400, maxChars - reserve)
  const headBudget = Math.floor(budget * 0.35)
  const tailBudget = Math.floor(budget * 0.35)
  const midBudget = budget - headBudget - tailBudget

  const take = (from: number, dir: 1 | -1, limit: number): number => {
    let used = 0
    let idx = from
    let count = 0
    while (idx >= 0 && idx < lines.length) {
      const len = Math.min(lines[idx]!.length, 400) + 1
      if (used + len > limit) break
      used += len
      idx += dir
      count++
    }
    return count
  }
  const headCount = take(0, 1, headBudget)
  const tailCount = take(lines.length - 1, -1, tailBudget)
  const headEnd = headCount
  const tailStart = Math.max(headEnd, lines.length - tailCount)

  const mid: Array<{ i: number; line: string }> = []
  let used = 0
  for (let i = headEnd; i < tailStart; i++) {
    const l = lines[i]!
    if (IMPORTANT.test(l)) {
      const clipped = l.length > 400 ? l.slice(0, 400) + '…' : l
      if (used + clipped.length + 1 > midBudget) break
      mid.push({ i, line: clipped })
      used += clipped.length + 1
    }
  }

  const parts: string[] = []
  parts.push(...lines.slice(0, headEnd).map((l) => (l.length > 400 ? l.slice(0, 400) + '…' : l)))
  let cursor = headEnd
  for (const m of mid) {
    if (m.i > cursor) parts.push(`… ${m.i - cursor} lines …`)
    parts.push(m.line)
    cursor = m.i + 1
  }
  if (tailStart > cursor) parts.push(`… ${tailStart - cursor} lines …`)
  parts.push(...lines.slice(tailStart).map((l) => (l.length > 400 ? l.slice(0, 400) + '…' : l)))
  const omittedLines = lines.length - (headEnd + mid.length + (lines.length - tailStart))
  const body = parts.join('\n')
  const out = `${body}\n${hint(lines.length - omittedLines, omittedLines)}`
  return { text: out, omittedChars: Math.max(0, fullLength - out.length), fullLength, compressed: true }
}

/** Shrink an old tool result during compaction: keep its first lines, its error lines and its end. */
export function shrinkForCompaction(content: string, fullLength: number): string {
  const lines = collapseRepeats(stripAnsi(content).split('\n'))
  const head = lines.slice(0, 6).join('\n').slice(0, 400)
  const important: string[] = []
  let used = 0
  for (const l of lines.slice(6, -4)) {
    if (IMPORTANT.test(l) && used < 450) {
      const c = l.length > 200 ? l.slice(0, 200) + '…' : l
      important.push(c)
      used += c.length
    }
  }
  const tail = lines.slice(-4).join('\n').slice(-250)
  const mid = important.length ? `\n${important.join('\n')}\n` : '\n'
  return `${head}${mid}…[${Math.max(0, fullLength - head.length - used - tail.length)} chars removed to save cost — the full output is in the audit log]…\n${tail}`
}

export function contentHash(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

/**
 * Keeps full tool outputs retrievable. Memory first (bounded), the session's
 * folder second, so a resumed session can still be asked for more.
 */
export class OutputStore {
  private memory = new Map<string, string>()
  private bytes = 0
  constructor(private readonly dir: string | null, private readonly maxBytes = 4_000_000) {}

  put(id: string, text: string): void {
    const safe = safeId(id)
    this.memory.set(safe, text)
    this.bytes += text.length
    while (this.bytes > this.maxBytes && this.memory.size > 1) {
      const oldest = this.memory.keys().next().value as string
      this.bytes -= this.memory.get(oldest)?.length ?? 0
      this.memory.delete(oldest)
    }
    if (this.dir) {
      const dir = this.dir
      void mkdir(dir, { recursive: true }).then(() => writeFile(join(dir, `${safe}.txt`), text, 'utf8')).catch(() => {})
    }
  }

  async get(id: string): Promise<string | null> {
    const safe = safeId(id)
    const m = this.memory.get(safe)
    if (m !== undefined) return m
    if (!this.dir) return null
    try {
      return await readFile(join(this.dir, `${safe}.txt`), 'utf8')
    } catch {
      return null
    }
  }
}

/** A handle is a tool-call id: never a path. */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)
}

export interface OutputQuery {
  head?: number
  tail?: number
  grep?: string
  from?: number
  to?: number
  context?: number
}

/** Answer a `tool_output` request from the stored text. Bounded: the answer itself never explodes. */
export function queryOutput(full: string, q: OutputQuery, maxChars = 6_000): string {
  const lines = stripAnsi(full).split('\n')
  let picked: string[]
  let label: string
  if (q.grep) {
    let re: RegExp
    try {
      re = new RegExp(q.grep, 'i')
    } catch {
      re = new RegExp(q.grep.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
    }
    const ctx = Math.min(Math.max(q.context ?? 1, 0), 5)
    const keep = new Set<number>()
    lines.forEach((l, i) => {
      if (re.test(l)) for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) keep.add(k)
    })
    picked = [...keep].sort((a, b) => a - b).map((i) => `${i + 1}: ${lines[i]}`)
    label = `${picked.length} lines around matches of /${q.grep}/`
  } else if (q.from || q.to) {
    const a = Math.max(1, q.from ?? 1)
    const b = Math.min(lines.length, q.to ?? a + 199)
    picked = lines.slice(a - 1, b).map((l, i) => `${a + i}: ${l}`)
    label = `lines ${a}-${b}`
  } else if (q.tail) {
    const n = Math.min(q.tail, lines.length)
    picked = lines.slice(lines.length - n).map((l, i) => `${lines.length - n + i + 1}: ${l}`)
    label = `last ${n} lines`
  } else {
    const n = Math.min(q.head ?? 80, lines.length)
    picked = lines.slice(0, n).map((l, i) => `${i + 1}: ${l}`)
    label = `first ${n} lines`
  }
  let text = picked.join('\n')
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…[answer truncated — narrow the request]'
  return `[${label} of ${lines.length}]\n${text || '(nothing matched)'}`
}
