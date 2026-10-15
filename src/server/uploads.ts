import { randomBytes } from 'node:crypto'
import { MAX_ATTACHMENTS, prepareAttachment, stage, type Staged } from '../core/attachments.js'

/**
 * Files a client uploaded and has not yet sent with a message. Each upload is
 * bound to the principal who made it, so one guest can never attach another's
 * file, and a message can only reference an upload by its opaque id — the text
 * of a message never decides which file is read.
 */

export interface UploadInfo {
  id: string
  name: string
  kind: 'image' | 'text'
  size: number
  note?: string
}

const TTL_MS = 60 * 60_000
const MAX_PENDING_PER_PRINCIPAL = 12

interface Entry {
  who: string
  staged: Staged
  at: number
}

export class Uploads {
  private items = new Map<string, Entry>()

  constructor(private readonly dir?: string) {}

  /** Check, classify and keep an uploaded file. Throws a user-readable Error when it is refused. */
  async add(who: string, name: string, bytes: Buffer, now = Date.now()): Promise<UploadInfo> {
    this.sweep(now)
    const mine = [...this.items.values()].filter((e) => e.who === who).length
    if (mine >= MAX_PENDING_PER_PRINCIPAL) throw new Error('too many files waiting — send your message first')
    const staged = await stage(prepareAttachment(name, bytes), this.dir)
    const id = `u_${randomBytes(9).toString('base64url')}`
    this.items.set(id, { who, staged, at: now })
    return { id, name: staged.name, kind: staged.kind, size: staged.size, ...(staged.note ? { note: staged.note } : {}) }
  }

  /** Take the blocks of these uploads (each id works once, for its owner only). Unknown or foreign ids are an error. */
  claim(who: string, ids: string[], now = Date.now()): string[] {
    this.sweep(now)
    const picked = [...new Set(ids)].slice(0, MAX_ATTACHMENTS)
    const blocks: string[] = []
    for (const id of picked) {
      const e = this.items.get(id)
      if (!e || e.who !== who) throw new Error('an attached file expired or is not yours — attach it again')
      blocks.push(e.staged.block)
    }
    for (const id of picked) this.items.delete(id)
    return blocks
  }

  private sweep(now: number): void {
    for (const [id, e] of this.items) if (now - e.at > TTL_MS) this.items.delete(id)
  }

  get size(): number {
    return this.items.size
  }
}
