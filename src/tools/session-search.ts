import { z } from 'zod'
import type { Tool, ToolResult } from './types.js'
import { listSessions, loadSession } from '../core/store.js'
import { scrubAll } from '../security/redact.js'

type Args = { query: string; limit?: number; allFolders?: boolean }

const MAX_SESSIONS_SCANNED = 80
const SNIPPET = 220

/** Words of the query that must all appear (case-insensitive) in the same message. */
const wordsOf = (q: string): string[] => q.toLowerCase().split(/\s+/).filter((w) => w.length > 1)

/**
 * `session_search`: find what was said or done in earlier sessions ("what did we decide about the retry logic?").
 * Read-only. It looks at this folder's sessions by default (the agent may widen it to every folder), at most the most
 * recent 80, and returns short snippets with the session id; the answer is in the text, never a full transcript.
 */
export const sessionSearchTool: Tool<Args> = {
  name: 'session_search',
  description:
    'Search earlier sessions (this folder by default) for what was discussed or done: ask when the user refers to past work ("like last time", ' +
    '"what did we decide about X"). Returns short snippets with the session id; use them as leads, they may be out of date.',
  readonly: true,
  schema: z
    .object({
      query: z.string().min(2).max(200).describe('Words that appear in the messages you are looking for'),
      limit: z.number().int().min(1).max(10).optional().describe('How many snippets to return (default 5)'),
      allFolders: z.boolean().optional().describe('Search sessions from every folder, not only this one'),
    })
    .describe('Search past sessions'),
  async execute(args, ctx): Promise<ToolResult> {
    const words = wordsOf(args.query)
    if (!words.length) return { ok: false, output: 'Give at least one word of two letters or more.' }
    const here = ctx.cwd.toLowerCase()
    const recent = (await listSessions())
      .filter((s) => s.id !== ctx.sessionId && (args.allFolders || s.cwd.toLowerCase() === here))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, MAX_SESSIONS_SCANNED)
    const hits: Array<{ id: string; at: string; objective: string; role: string; text: string; score: number }> = []
    for (const s of recent) {
      const full = await loadSession(s.id)
      if (!full) continue
      for (const m of full.transcript) {
        if (m.role !== 'user' && m.role !== 'assistant') continue
        const lower = m.content.toLowerCase()
        if (!words.every((w) => lower.includes(w))) continue
        const at = lower.indexOf(words[0]!)
        const from = Math.max(0, at - 60)
        hits.push({
          id: s.id,
          at: s.updatedAt.slice(0, 10),
          objective: s.objective.slice(0, 80),
          role: m.role,
          text: m.content.slice(from, from + SNIPPET).replace(/\s+/g, ' '),
          score: words.reduce((n, w) => n + lower.split(w).length - 1, 0) + (m.role === 'user' ? 1 : 0),
        })
      }
    }
    hits.sort((a, b) => b.score - a.score || b.at.localeCompare(a.at))
    const top = hits.slice(0, args.limit ?? 5)
    if (!top.length) return { ok: true, output: `No earlier session mentions "${args.query}" (looked at ${recent.length} recent session(s)${args.allFolders ? ' in every folder' : ' in this folder'}).` }
    const lines = top.map((h) => `- ${h.id} · ${h.at} · "${h.objective}" · ${h.role}: …${h.text}…`)
    return { ok: true, output: scrubAll(`${top.length} match(es), best first:\n${lines.join('\n')}`) }
  },
}
