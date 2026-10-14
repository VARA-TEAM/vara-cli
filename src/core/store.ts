import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { sessionDir, sessionEventsFile, sessionStateFile, sessionsDir } from '../config/paths.js'
import { aggregateModelCalls } from '../llm/cost.js'
import type { EngineEvent, Session } from './types.js'

/**
 * Persistence: append-only event log (JSONL) + periodic state snapshot.
 *
 * The event log is the source of truth for auditing what happened.
 * The snapshot is the fast path for resume. If the process dies mid-turn,
 * the snapshot still says `running`; loadSession() marks it `interrupted`
 * so nobody assumes the interrupted turn completed successfully.
 */
export async function ensureStore(): Promise<void> {
  await mkdir(sessionsDir, { recursive: true })
}

export async function saveSession(session: Session): Promise<void> {
  const dir = sessionDir(session.id)
  await mkdir(dir, { recursive: true })
  const state: Session = { ...session, updatedAt: new Date().toISOString() }
  await writeAtomic(sessionStateFile(session.id), JSON.stringify(state, null, 2))
}

let tmpCounter = 0

/**
 * Write-then-rename: a concurrent reader (the session list, another client of a
 * shared host) sees the old file or the new one, never half of one. Windows can
 * briefly refuse the rename while a reader holds the file, so retry a few times.
 */
async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${tmpCounter++}.tmp`
  await writeFile(tmp, text, 'utf8')
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(tmp, file)
      return
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (attempt < 8 && (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) {
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)))
        continue
      }
      await unlink(tmp).catch(() => {})
      throw err
    }
  }
}

export async function appendEvent(sessionId: string, event: EngineEvent): Promise<void> {
  const file = sessionEventsFile(sessionId)
  await mkdir(sessionDir(sessionId), { recursive: true })
  const line = JSON.stringify({ at: new Date().toISOString(), ...event }) + '\n'
  const { appendFile } = await import('node:fs/promises')
  await appendFile(file, line, 'utf8')
}

export async function loadSession(id: string): Promise<Session | null> {
  const file = sessionStateFile(id)
  if (!existsSync(file)) return null
  const raw = await readFile(file, 'utf8')
  const session = JSON.parse(raw) as Session

  // A session persisted as `running` was killed mid-turn. Recover, do not assume success.
  if (session.state === 'running') {
    session.state = 'interrupted'
    session.stateReason =
      'Process ended while the session was running. The in-flight turn did NOT complete; resume to redo it.'
  }

  // Migrate sessions created before requirement tracking: an empty list would
  // let `complete` pass with 0/0 requirements "verified". Derive from the
  // acceptance conditions, or fall back to the objective itself.
  if (!session.activeRequirements?.length) {
    session.activeRequirements = session.config.acceptance.length
      ? [...session.config.acceptance]
      : [`The stated objective is achieved and verified: ${session.config.objective}`]
  }

  // Cost-truth migration: sessions persisted before usage accounting lack the
  // token/cost fields and the per-call ledger. Absent data stays UNKNOWN —
  // we never backfill zeros, because "not measured" is not "nothing spent".
  const usage = session.usage as Partial<Session['usage']> | undefined
  if (usage && usage.inputTokens === undefined) {
    usage.inputTokens = null
    usage.outputTokens = null
    usage.cachedInputTokens = null
    usage.cacheWriteTokens = null
    usage.costUsd = null
    // A legacy session that made model calls has unknown, not zero, cost.
    usage.costPartial = (usage.modelCalls ?? 0) > 0
    usage.unpricedCalls = usage.modelCalls ?? 0
    session.usage = usage as Session['usage']
  }
  session.modelCalls ??= []
  // The ledger is the source of truth: recompute totals from it so a resumed
  // (or externally edited) snapshot can never carry double-counted totals.
  if (session.modelCalls.length > 0) {
    const totals = aggregateModelCalls(session.modelCalls)
    session.usage.inputTokens = totals.inputTokens
    session.usage.outputTokens = totals.outputTokens
    session.usage.cachedInputTokens = totals.cachedInputTokens
    session.usage.cacheWriteTokens = totals.cacheWriteTokens
    session.usage.costUsd = totals.costUsd
    session.usage.costPartial = totals.costPartial
    session.usage.unpricedCalls = totals.unpricedCalls
  }
  return session
}

export interface SessionSummary {
  id: string
  updatedAt: string
  objective: string
  state: string
  kind: string
  cwd: string
  costUsd: number | null
  unpricedCalls: number
  modelCalls: number
  turns: number
  mode: string
  model: string | undefined
  intent: string | undefined
  participant: { id: string; name: string } | undefined
  shared: boolean
}

export async function listSessions(): Promise<SessionSummary[]> {
  if (!existsSync(sessionsDir)) return []
  const entries = await readdir(sessionsDir, { withFileTypes: true })
  const out: SessionSummary[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let session: Session | null = null
    try {
      session = await loadSession(entry.name)
    } catch {
      continue // one damaged session must never hide the others
    }
    if (!session) continue
    out.push({
      id: session.id,
      updatedAt: session.updatedAt,
      objective: session.config.objective.slice(0, 100),
      state: session.state,
      kind: session.config.kind,
      cwd: session.config.cwd,
      costUsd: session.usage.costUsd ?? null,
      unpricedCalls: session.usage.unpricedCalls ?? 0,
      modelCalls: session.usage.modelCalls ?? 0,
      turns: session.usage.turns ?? 0,
      mode: session.config.mode,
      model: session.config.model,
      intent: session.intent,
      participant: session.participant,
      shared: session.shared === true,
    })
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1))
}

export async function readEventLog(id: string): Promise<Array<Record<string, unknown>>> {
  const file = sessionEventsFile(id)
  if (!existsSync(file)) return []
  const raw = await readFile(file, 'utf8')
  return raw
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}
