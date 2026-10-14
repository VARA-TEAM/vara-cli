import { readFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute } from 'node:path'

/** Marker that separates what the user typed from the files attached to it. */
export const ATTACH_MARK = '\n\n[attached files]'

const MAX_FILE_BYTES = 120_000
const MAX_FILES = 6

/** What the user typed, without the attached file bodies (titles, sidebar, tabs). */
export function cleanTitle(objective: string): string {
  const cut = objective.indexOf(ATTACH_MARK)
  const typed = cut >= 0 ? objective.slice(0, cut) : objective
  return typed.replace(/\s+/g, ' ').trim()
}

/** `@src/a.ts` tokens in a message. */
export function findMentions(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(/(?:^|\s)@([^\s,;:!?)"'`]+)/g)) {
    const p = m[1]!.replace(/[.]+$/, '')
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/**
 * Attach the files a message mentions with `@path`. Only regular files inside
 * the working directory, up to 120 KB each, 6 per message — anything else is
 * left as typed. The typed text is kept intact; the bodies follow a marker.
 */
export async function expandMentions(text: string, cwd: string): Promise<{ text: string; files: string[] }> {
  const files: string[] = []
  const blocks: string[] = []
  for (const mention of findMentions(text).slice(0, MAX_FILES)) {
    const abs = resolve(cwd, mention)
    const rel = relative(cwd, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    try {
      const st = await stat(abs)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      const body = await readFile(abs, 'utf8')
      if (body.includes('\u0000')) continue
      const shown = rel.replace(/\\/g, '/')
      files.push(shown)
      blocks.push(`<file path="${shown}">\n${body}\n</file>`)
    } catch {
      /* not a file: leave the mention as typed */
    }
  }
  return blocks.length ? { text: `${text}${ATTACH_MARK}\n${blocks.join('\n')}`, files } : { text, files }
}
