import type { SessionView, ToolCall, TranscriptItem } from './types'

/** What the chat draws, derived from the host's snapshot. Pure and tested. */
export type ChatItem =
  | { kind: 'user'; text: string; author?: string; at: string; images?: Array<{ id: string; name: string }>; files?: string[] }
  | { kind: 'assistant'; text: string; at: string }
  | { kind: 'tool'; id: string; name: string; args: string; output?: string; ok?: boolean; at: string }

const ATTRIBUTION = /^\[from ([^\]\n]{1,40})\]\s+/

export function buildItems(view: Pick<SessionView, 'transcript'>): ChatItem[] {
  const outputs = new Map<string, { content: string; ok: boolean }>()
  for (const m of view.transcript) {
    if (m.role === 'tool' && m.toolCallId) outputs.set(m.toolCallId, { content: m.content.replace(/^\[(OK|FAIL)\]\s?/, ''), ok: m.content.startsWith('[OK]') })
  }
  const items: ChatItem[] = []
  for (const m of view.transcript as TranscriptItem[]) {
    if (m.role === 'user') {
      const a = ATTRIBUTION.exec(m.content)
      const raw = a ? m.content.slice(a[0].length) : m.content
      // Attached files ride after a marker; show only what the person typed.
      const [text = raw, ...tail] = raw.split('\n\n[attached files]')
      const attached = tail.join('')
      const { images, files } = attachedOf(attached)
      items.push({ kind: 'user', text, ...(a ? { author: a[1]! } : {}), at: m.at, ...(images.length ? { images } : {}), ...(files.length ? { files } : {}) })
    } else if (m.role === 'assistant') {
      if (m.content.trim()) items.push({ kind: 'assistant', text: m.content, at: m.at })
      for (const c of m.toolCalls ?? []) {
        const out = outputs.get(c.id)
        items.push({ kind: 'tool', id: c.id, name: c.name, args: c.arguments, ...(out ? { output: out.content, ok: out.ok } : {}), at: m.at })
      }
    }
  }
  return items
}

/** The images and file names that ride after a message's attachment marker. */
export function attachedOf(section: string): { images: Array<{ id: string; name: string }>; files: string[] } {
  const images: Array<{ id: string; name: string }> = []
  for (const m of section.matchAll(/<image id="([a-f0-9]{16}\.(?:png|jpg|gif|webp))"(?: name="([^"<>]{0,120})")?\/>/g)) images.push({ id: m[1]!, name: m[2] ?? 'image' })
  const files: string[] = []
  for (const m of section.matchAll(/<file (?:name|path)="([^"]{1,200})"/g)) files.push(m[1]!)
  return { images, files }
}

/** One-line summary of a tool call for its card header. */
export function toolSummary(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  try {
    const a = JSON.parse(call.arguments) as Record<string, unknown>
    if (typeof a['command'] === 'string') return `$ ${a['command']}`
    if (typeof a['path'] === 'string') return `${a['path']}${typeof a['pattern'] === 'string' ? `  “${a['pattern']}”` : ''}`
    if (typeof a['pattern'] === 'string') return `“${a['pattern']}”`
    if (typeof a['question'] === 'string') return a['question']
    if (typeof a['name'] === 'string') return a['name']
    if (Array.isArray(a['tasks'])) return `${a['tasks'].length} sub-agent${a['tasks'].length === 1 ? '' : 's'}`
    const first = Object.entries(a)[0]
    return first ? `${first[0]}: ${typeof first[1] === 'string' ? first[1] : JSON.stringify(first[1])}`.slice(0, 120) : ''
  } catch {
    return call.arguments.slice(0, 120)
  }
}

/** Files the agent wrote, edited or deleted — derived from the tool calls. */
export function changedFiles(view: Pick<SessionView, 'transcript'>): Array<{ path: string; op: 'new' | 'edit' | 'del' }> {
  const seen = new Map<string, 'new' | 'edit' | 'del'>()
  for (const m of view.transcript) {
    for (const c of m.toolCalls ?? []) {
      if (!['write_file', 'edit_file', 'delete_file', 'apply_patch'].includes(c.name)) continue
      try {
        const path = (JSON.parse(c.arguments) as { path?: string }).path
        if (!path) continue
        const op = c.name === 'delete_file' ? 'del' : c.name === 'write_file' && !seen.has(path) ? 'new' : 'edit'
        seen.set(path, seen.get(path) === 'new' && op === 'edit' ? 'new' : op)
      } catch {
        /* unreadable arguments */
      }
    }
  }
  return [...seen].map(([path, op]) => ({ path, op }))
}

export function relativeTime(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h`
  const d = Math.round(h / 24)
  return d < 30 ? `${d}d` : new Date(t).toLocaleDateString()
}

/** Time remaining until a future instant, as 3d / 5h / 20m. */
export function until(iso: string, now = Date.now()): string {
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return '0m'
  const m = Math.round(ms / 60_000)
  if (m < 60) return `${Math.max(1, m)}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

export function formatCost(usd: number | null, partial = false): string | null {
  if (usd === null) return null
  return `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}${partial ? '+' : ''}`
}

export function formatTokens(n: number | null): string {
  if (n === null) return '?'
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${Math.round(n / 1_000)}k` : String(n)
}
