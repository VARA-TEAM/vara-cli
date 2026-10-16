import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { VARA_HOME } from '../config/paths.js'

/**
 * Two protections around the agent's file tools.
 *
 *  1. Stale edits. The tools remember what each file looked like when the agent last read or wrote it in this
 *     session. If the file has changed on disk since (you edited it, a formatter ran, another process wrote it), an
 *     edit that was planned from the old text is refused and the agent is told to read the file again — instead of
 *     silently overwriting your change.
 *  2. Checkpoints. Before every write, edit or delete the previous content is saved, so `/undo` can put it back,
 *     also after a restart. Files over MAX_BYTES are not saved (and say so).
 */

const MAX_BYTES = 2_000_000
const known = new Map<string, Map<string, string>>() // session → absolute path → hash of the content last seen

const hash = (text: string): string => createHash('sha1').update(text).digest('hex')

/** Remember what the agent saw of this file. */
export function noteSeen(sessionId: string, abs: string, content: string): void {
  let m = known.get(sessionId)
  if (!m) known.set(sessionId, (m = new Map()))
  m.set(abs, hash(content))
}

/** An error message when the agent last saw a different version of this file than the one on disk, else null. */
export function staleReason(sessionId: string, abs: string, relPath: string, current: string): string | null {
  const seen = known.get(sessionId)?.get(abs)
  if (!seen || seen === hash(current)) return null
  return `${relPath} changed on disk since you last read it (someone or something else edited it). Read it again with read_file, then redo your change on the current text. Nothing was written.`
}

export function forgetSession(sessionId: string): void {
  known.delete(sessionId)
}

/* ---------------- checkpoints ---------------- */

export interface Checkpoint {
  id: number
  at: string
  /** Path relative to the working directory, for display. */
  path: string
  abs: string
  /** The file did not exist before: undo deletes it. */
  created: boolean
  /** Why nothing could be saved (too large). */
  skipped?: string
  action: 'write' | 'edit' | 'delete'
}

const dirOf = (sessionId: string): string => join(VARA_HOME, 'checkpoints', sessionId.replace(/[^\w-]/g, '_'))

async function readIndex(sessionId: string): Promise<Checkpoint[]> {
  try {
    return JSON.parse(await readFile(join(dirOf(sessionId), 'index.json'), 'utf8')) as Checkpoint[]
  } catch {
    return []
  }
}

async function writeIndex(sessionId: string, list: Checkpoint[]): Promise<void> {
  await mkdir(dirOf(sessionId), { recursive: true })
  await writeFile(join(dirOf(sessionId), 'index.json'), JSON.stringify(list), 'utf8')
}

/** Save the file's current state before the agent changes it. `previous` is null when the file does not exist yet. */
export async function checkpoint(sessionId: string, abs: string, relPath: string, previous: string | null, action: Checkpoint['action']): Promise<void> {
  try {
    const list = await readIndex(sessionId)
    const id = (list.at(-1)?.id ?? 0) + 1
    const entry: Checkpoint = { id, at: new Date().toISOString(), path: relPath, abs, created: previous === null, action }
    if (previous !== null) {
      if (Buffer.byteLength(previous, 'utf8') > MAX_BYTES) entry.skipped = 'file too large to save'
      else await writeFile(join(dirOf(sessionId), `${id}.bak`), previous, 'utf8').catch(async () => (await mkdir(dirOf(sessionId), { recursive: true }), writeFile(join(dirOf(sessionId), `${id}.bak`), previous, 'utf8')))
    }
    list.push(entry)
    await writeIndex(sessionId, list.slice(-200))
  } catch {
    /* a failed backup must never stop the work itself */
  }
}

export async function listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
  return readIndex(sessionId)
}

export interface UndoResult {
  restored: Array<{ path: string; what: string }>
  failed: Array<{ path: string; why: string }>
}

/** Put back the last `count` changes, newest first. */
export async function undo(sessionId: string, count = 1): Promise<UndoResult> {
  const list = await readIndex(sessionId)
  const result: UndoResult = { restored: [], failed: [] }
  for (let i = 0; i < count && list.length; i++) {
    const entry = list.pop()!
    try {
      if (entry.created) {
        await rm(entry.abs, { force: true })
        result.restored.push({ path: entry.path, what: 'removed (it was created by the agent)' })
      } else if (entry.skipped) {
        result.failed.push({ path: entry.path, why: entry.skipped })
      } else {
        const previous = await readFile(join(dirOf(sessionId), `${entry.id}.bak`), 'utf8')
        await mkdir(dirname(entry.abs), { recursive: true })
        await writeFile(entry.abs, previous, 'utf8')
        result.restored.push({ path: entry.path, what: entry.action === 'delete' ? 'brought back' : 'restored to the previous version' })
        known.get(sessionId)?.delete(entry.abs)
      }
      await rm(join(dirOf(sessionId), `${entry.id}.bak`), { force: true })
    } catch (err) {
      result.failed.push({ path: entry.path, why: (err as Error).message })
    }
  }
  await writeIndex(sessionId, list)
  return result
}

/** For tests and clean-up. */
export async function clearCheckpoints(sessionId: string): Promise<void> {
  await rm(dirOf(sessionId), { recursive: true, force: true })
}
