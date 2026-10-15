import { randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, rm, stat, writeFile, readdir } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { VARA_HOME, sessionDir } from '../config/paths.js'

/**
 * Attachments: images the model can look at, and text / PDF files it can read.
 *
 * Storage is private to the session: `~/.vara/sessions/<id>/attachments/<id>.<ext>`.
 * A file first lands in a staging folder (the session may not exist yet) and is
 * moved into the session when the message that carries it is sent. The model
 * context refers to an image only by `<image id="…" name="…"/>`; the id must
 * match `IMAGE_ID` and is resolved INSIDE the session's own folder, so text a
 * user (or guest) types can never make the host read another path or session.
 */

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const MAX_TEXT_CHARS = 120_000
export const MAX_ATTACHMENTS = 6

export const stagingDir: string = join(VARA_HOME, 'uploads')
const IMAGE_ID = /^[a-f0-9]{16}\.(png|jpg|gif|webp)$/
const IMAGE_REF = /<image id="([a-f0-9]{16}\.(?:png|jpg|gif|webp))"(?: name="([^"<>]{0,120})")?\/>/g

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
const EXT_OF: Record<ImageMime, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }
const MIME_OF: Record<string, ImageMime> = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }

/** The real type of an image from its first bytes — the client's claim is never trusted. SVG is refused (it can carry script). */
export function sniffImage(b: Uint8Array): ImageMime | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif'
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return null
}

const isPdf = (b: Uint8Array): boolean => b.length > 5 && b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46

export type Prepared =
  | { kind: 'image'; name: string; mime: ImageMime; bytes: Buffer }
  | { kind: 'text'; name: string; text: string; note?: string }
  | { kind: 'rejected'; name: string; reason: string }

/** Decide what a file is and whether it may be attached. Pure: no disk access. */
export function prepareAttachment(name: string, bytes: Buffer): Prepared {
  const clean = safeName(name)
  if (bytes.length === 0) return { kind: 'rejected', name: clean, reason: 'the file is empty' }
  if (bytes.length > MAX_UPLOAD_BYTES) return { kind: 'rejected', name: clean, reason: `larger than ${MAX_UPLOAD_BYTES / 1024 / 1024} MB` }
  const mime = sniffImage(bytes)
  if (mime) {
    if (bytes.length > MAX_IMAGE_BYTES) return { kind: 'rejected', name: clean, reason: `image larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB` }
    return { kind: 'image', name: clean, mime, bytes }
  }
  if (isPdf(bytes)) {
    const text = extractPdfText(bytes)
    if (text.trim().length < 20) return { kind: 'rejected', name: clean, reason: 'no readable text in this PDF (scanned or encrypted); attach it as images instead' }
    return clip(clean, text, 'text extracted from the PDF (layout and images are not included)')
  }
  if (bytes.includes(0)) return { kind: 'rejected', name: clean, reason: 'not an image, PDF or text file' }
  if (/^<svg|^<\?xml/i.test(bytes.subarray(0, 64).toString('utf8').trimStart())) return { kind: 'rejected', name: clean, reason: 'SVG is not supported; attach a PNG or JPEG' }
  return clip(clean, bytes.toString('utf8'))
}

function clip(name: string, text: string, note?: string): Prepared {
  if (text.length <= MAX_TEXT_CHARS) return { kind: 'text', name, text, ...(note ? { note } : {}) }
  const cut = `first ${MAX_TEXT_CHARS} of ${text.length} characters${note ? `; ${note}` : ''}`
  return { kind: 'text', name, text: text.slice(0, MAX_TEXT_CHARS), note: cut }
}

export function safeName(name: string): string {
  const base = basename(name.replace(/\\/g, '/')).replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 80)
  return base || 'file'
}

/** `<file>` block for text-like attachments. The body cannot close the tag early. */
export function fileBlock(name: string, text: string, note?: string): string {
  const body = text.replace(/<\/file>/gi, '<\\/file>')
  return `<file name="${safeName(name)}"${note ? ` note="${note.replace(/"/g, "'")}"` : ''}>\n${body}\n</file>`
}

/** What a user types must not be able to forge an attachment reference. */
export function neutralize(text: string): string {
  return text.replace(/<image id=/gi, '<image_ id=')
}

export const imageMarker = (id: string, name: string): string => `<image id="${id}" name="${safeName(name).replace(/"/g, '')}"/>`

export function imageRefs(text: string): Array<{ id: string; name: string }> {
  const out: Array<{ id: string; name: string }> = []
  for (const m of text.matchAll(IMAGE_REF)) out.push({ id: m[1]!, name: m[2] ?? 'image' })
  return out
}

/* ---------- staging and session storage ---------- */

export interface Staged {
  /** Marker (`<image …/>`) or file block to append to the message. */
  block: string
  kind: 'image' | 'text'
  name: string
  size: number
  /** Staged image id (images only). */
  id?: string
  note?: string
}

/** Put a prepared attachment where it can wait for its message. Images are written to staging; text is inlined. */
export async function stage(p: Prepared, dir: string = stagingDir): Promise<Staged> {
  if (p.kind === 'rejected') throw new Error(`${p.name}: ${p.reason}`)
  if (p.kind === 'text') return { block: fileBlock(p.name, p.text, p.note), kind: 'text', name: p.name, size: p.text.length, ...(p.note ? { note: p.note } : {}) }
  await mkdir(dir, { recursive: true })
  const id = `${randomBytes(8).toString('hex')}.${EXT_OF[p.mime]}`
  await writeFile(join(dir, id), p.bytes, { mode: 0o600 })
  return { block: imageMarker(id, p.name), kind: 'image', name: p.name, size: p.bytes.length, id }
}

export function attachmentsDir(sessionId: string): string {
  return join(sessionDir(sessionId), 'attachments')
}

/** Move the staged images a message refers to into the session's own folder. Unknown ids are left alone (they simply will not resolve). */
export async function adoptStaged(sessionId: string, text: string, from: string = stagingDir): Promise<string[]> {
  const moved: string[] = []
  const dest = attachmentsDir(sessionId)
  for (const { id } of imageRefs(text).slice(0, MAX_ATTACHMENTS)) {
    if (!IMAGE_ID.test(id)) continue
    try {
      await mkdir(dest, { recursive: true })
      await rename(join(from, id), join(dest, id))
      moved.push(id)
    } catch {
      /* not staged here (already adopted, or never existed) */
    }
  }
  return moved
}

/** Staged files older than `maxAgeMs` that no message claimed. */
export async function sweepStaging(maxAgeMs = 24 * 3_600_000, dir: string = stagingDir): Promise<number> {
  let n = 0
  try {
    for (const f of await readdir(dir)) {
      const full = join(dir, f)
      const st = await stat(full).catch(() => null)
      if (st && Date.now() - st.mtimeMs > maxAgeMs) {
        await rm(full, { force: true })
        n++
      }
    }
  } catch {
    /* no staging folder yet */
  }
  return n
}

export interface ImageBlock {
  mime: ImageMime
  /** base64, no prefix. */
  data: string
  name: string
}

const cache = new Map<string, ImageBlock>()

/** Load an image of a session for the model. Only ids inside the session's own attachments folder resolve. */
export function loadImage(sessionId: string, id: string, name = 'image'): ImageBlock | null {
  if (!IMAGE_ID.test(id)) return null
  const key = `${sessionId}/${id}`
  const hit = cache.get(key)
  if (hit) return hit
  let block: ImageBlock | null = null
  try {
    const buf = readFileSync(join(attachmentsDir(sessionId), id))
    const mime = sniffImage(buf)
    if (mime && buf.length <= MAX_IMAGE_BYTES) block = { mime, data: buf.toString('base64'), name }
  } catch {
    block = null
  }
  // Only successes are remembered: a file that is not there yet (still being adopted) must be found next time.
  if (block) {
    if (cache.size > 64) cache.clear()
    cache.set(key, block)
  }
  return block
}

export async function readAttachment(sessionId: string, id: string): Promise<{ mime: ImageMime; bytes: Buffer } | null> {
  if (!IMAGE_ID.test(id)) return null
  try {
    const bytes = await readFile(join(attachmentsDir(sessionId), id))
    const mime = sniffImage(bytes)
    return mime ? { mime, bytes } : null
  } catch {
    return null
  }
}

export const mimeOfId = (id: string): ImageMime | undefined => MIME_OF[extname(id).slice(1)]

/**
 * The images of a message for a model: with vision they become blocks; without,
 * the marker is replaced by an honest one-line note so the model does not guess.
 */
export function resolveImages(sessionId: string, content: string, vision: boolean): { content: string; images: ImageBlock[] } {
  const refs = imageRefs(content)
  if (!refs.length) return { content, images: [] }
  const images: ImageBlock[] = []
  let text = content
  for (const r of refs) {
    const marker = imageMarker(r.id, r.name)
    const label = (suffix: string) => `[image "${r.name}" ${suffix}]`
    const block = vision ? loadImage(sessionId, r.id, r.name) : null
    if (block && images.length < MAX_ATTACHMENTS) {
      images.push(block)
      text = text.replace(marker, label('attached below'))
    } else {
      text = text.replace(marker, label(vision ? 'could not be loaded' : 'was attached but this model cannot view images'))
    }
  }
  // Markers whose name contained odd characters are left as typed: harmless text.
  return { content: text, images }
}

/* ---------- PDF text (no dependency; best effort) ---------- */

/** Text of the simple, text-based PDFs: Flate or plain content streams with Tj / TJ operators. Scanned or encrypted PDFs yield little or nothing. */
export function extractPdfText(pdf: Buffer): string {
  const raw = pdf.toString('latin1')
  if (/\/Encrypt\b/.test(raw)) return ''
  const out: string[] = []
  const re = /stream\r?\n/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw))) {
    const start = m.index + m[0].length
    const end = raw.indexOf('endstream', start)
    if (end < 0) break
    re.lastIndex = end
    const head = raw.slice(Math.max(0, m.index - 300), m.index)
    let body: string
    try {
      const chunk = pdf.subarray(start, end)
      body = /FlateDecode/.test(head) ? inflateSync(chunk).toString('latin1') : chunk.toString('latin1')
    } catch {
      continue
    }
    if (!/\bBT\b/.test(body)) continue
    for (const bt of body.matchAll(/BT([\s\S]*?)ET/g)) {
      let line = ''
      for (const op of bt[1]!.matchAll(/\[((?:[^\]\\]|\\.)*)\]\s*TJ|\(((?:[^()\\]|\\.)*)\)\s*(?:Tj|'|")|(T\*|Td|TD|T[mM])\b/g)) {
        if (op[3]) {
          if (op[3] !== 'Tm' && op[3] !== 'TM') line += '\n'
          continue
        }
        if (op[1] !== undefined) {
          for (const item of op[1].matchAll(/\(((?:[^()\\]|\\.)*)\)|(-?\d+(?:\.\d+)?)/g)) {
            if (item[1] !== undefined) line += unescapePdf(item[1])
            else if (Number(item[2]) < -200) line += ' '
          }
        } else if (op[2] !== undefined) line += unescapePdf(op[2])
      }
      if (line.trim()) out.push(line.replace(/\n{2,}/g, '\n').trim())
    }
  }
  return out.join('\n')
}

function unescapePdf(s: string): string {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c: string) => {
    if (/^[0-7]+$/.test(c)) return String.fromCharCode(parseInt(c, 8))
    return ({ n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' } as Record<string, string>)[c] ?? c
  })
}
