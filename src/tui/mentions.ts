import { readFile, stat } from 'node:fs/promises'
import { resolve, relative, isAbsolute, basename } from 'node:path'
import { MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, prepareAttachment, stage, type Staged } from '../core/attachments.js'

/** Marker that separates what the user typed from the files attached to it. */
export const ATTACH_MARK = '\n\n[attached files]'

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

export interface Expanded {
  text: string
  /** Names shown to the user ("attached a.ts, shot.png"). */
  files: string[]
  /** Things that were asked for but could not be attached, with the reason. */
  skipped: string[]
}

export interface ExpandOptions {
  /** Blocks already staged (from `/attach`), added after the mentioned files. */
  extra?: string[]
  /** Where images wait for their message (tests). */
  stagingDir?: string
  /** Also attach image/PDF paths that appear in the text (a file dragged onto a terminal). Off for the web host. */
  dropped?: boolean
}

/** Absolute paths to existing files, as a terminal pastes them when a file is dragged onto it (quoted or backslash-escaped). */
export function findDroppedPaths(text: string): string[] {
  const out: string[] = []
  const re = /"((?:[A-Za-z]:[\\/]|\/)[^"\n]+)"|'((?:[A-Za-z]:[\\/]|\/)[^'\n]+)'|(?:^|\s)((?:[A-Za-z]:[\\/]|\/)(?:\\ |[^\s])+)/g
  for (const m of text.matchAll(re)) {
    const p = (m[1] ?? m[2] ?? m[3] ?? '').replace(/\\ /g, ' ')
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** Read, check and stage one file for the next message. `abs` must already be a resolved path. */
export async function attachPath(abs: string, opts: ExpandOptions = {}): Promise<Staged> {
  const st = await stat(abs)
  if (!st.isFile()) throw new Error('not a file')
  if (st.size > MAX_UPLOAD_BYTES) throw new Error(`larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB`)
  return stage(prepareAttachment(basename(abs), await readFile(abs)), opts.stagingDir)
}

/**
 * Attach the files a message mentions with `@path`, plus any file dragged onto
 * the terminal (a pasted absolute path). `@` stays inside the working
 * directory; a dragged path is the user's own explicit act, so it may be
 * anywhere. Text up to 120 KB, images up to 5 MB (sent only to models that can
 * see), PDFs as extracted text, at most 6 per message. The typed text is kept
 * intact; the bodies follow a marker.
 */
export async function expandMentions(text: string, cwd: string, opts: ExpandOptions = {}): Promise<Expanded> {
  const files: string[] = []
  const skipped: string[] = []
  const blocks: string[] = [...(opts.extra ?? [])]
  const seen = new Set<string>()
  const candidates: Array<{ abs: string; shown: string }> = []
  for (const mention of findMentions(text)) {
    const abs = resolve(cwd, mention)
    const rel = relative(cwd, abs)
    if (rel.startsWith('..') || isAbsolute(rel)) continue
    candidates.push({ abs, shown: rel.replace(/\\/g, '/') })
  }
  // A dragged path is attached only for images and PDFs: a plain "look at /etc/hosts" in a sentence must not pull a file in.
  if (opts.dropped !== false) for (const p of findDroppedPaths(text)) if (/\.(png|jpe?g|gif|webp|pdf)$/i.test(p)) candidates.push({ abs: resolve(p), shown: basename(p) })
  for (const c of candidates) {
    if (files.length + (opts.extra?.length ?? 0) >= MAX_ATTACHMENTS) break
    if (seen.has(c.abs)) continue
    seen.add(c.abs)
    try {
      const st = await stat(c.abs)
      if (!st.isFile()) continue
      const s = await attachPath(c.abs, opts)
      blocks.push(s.kind === 'text' ? s.block.replace(/<file name="[^"]*"/, `<file path="${c.shown}"`) : s.block)
      files.push(c.shown)
    } catch (err) {
      const msg = (err as Error).message
      // A mention that is not a file is just text; a real file that was refused is worth saying.
      if (!/ENOENT|ENOTDIR|not a file/.test(msg)) skipped.push(`${c.shown}: ${msg}`)
    }
  }
  const body = blocks.join('\n')
  return blocks.length ? { text: `${text}${ATTACH_MARK}\n${body}`, files, skipped } : { text, files, skipped }
}

/** Append already-prepared attachment blocks to a message (after its own `[attached files]` section, if any). */
export function withBlocks(text: string, blocks: string[]): string {
  if (!blocks.length) return text
  return `${text}${text.includes(ATTACH_MARK) ? '\n' : ATTACH_MARK + '\n'}${blocks.join('\n')}`
}
