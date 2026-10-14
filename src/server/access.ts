import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { hostDir } from '../config/paths.js'

/**
 * Who may do what in a shared VARA host.
 *
 * The OWNER runs the host: their machine, their provider keys, their folder.
 * GUESTS join with an invite and get a GRANT — a set of switches the owner
 * controls and can change or revoke at any time. Permissions are enforced by
 * the host (this module), never by the web page: a guest who edits the page or
 * crafts requests by hand still hits `authorize()`.
 *
 * Guests never receive a provider key: their agent runs on the owner's machine
 * and they only exchange text and events.
 */

export type GrantPreset = 'viewer' | 'participant' | 'collaborator'

export interface Grant {
  preset: GrantPreset | 'custom'
  /** See the owner's shared session(s) live. */
  watch: boolean
  /** Send messages into a shared owner session. */
  sendShared: boolean
  /** Has their own session in the same folder (independent of the owner's). */
  ownSession: boolean
  /** locked = the model the owner picked; list = allowedModels only; any = any configured model. */
  modelPolicy: 'locked' | 'list' | 'any'
  allowedModels: string[]
  /** Highest power of the guest's own agent: plan = read-only, build = may change files. */
  mode: 'plan' | 'build'
  /** May the guest switch plan ↔ build (never above `mode`). */
  canChangeMode: boolean
  /** May the guest pause/interrupt a SHARED session run. (Their own sessions: always.) */
  canInterrupt: boolean
  /** Hard caps over everything the guest ever runs. Unset = unlimited. */
  maxModelCalls?: number
  maxCostUsd?: number
  /** ISO time after which the access stops working. */
  expiresAt?: string
}

export const PRESETS: Record<GrantPreset, Grant> = {
  /** Watch only. */
  viewer: {
    preset: 'viewer',
    watch: true,
    sendShared: false,
    ownSession: false,
    modelPolicy: 'locked',
    allowedModels: [],
    mode: 'plan',
    canChangeMode: false,
    canInterrupt: false,
  },
  /** Watch and talk in the owner's session; model locked; cannot interrupt. */
  participant: {
    preset: 'participant',
    watch: true,
    sendShared: true,
    ownSession: false,
    modelPolicy: 'locked',
    allowedModels: [],
    mode: 'plan',
    canChangeMode: false,
    canInterrupt: false,
  },
  /** Watch, talk, and work in their own session next to yours (read-only agent by default). */
  collaborator: {
    preset: 'collaborator',
    watch: true,
    sendShared: true,
    ownSession: true,
    modelPolicy: 'locked',
    allowedModels: [],
    mode: 'plan',
    canChangeMode: false,
    canInterrupt: false,
  },
}

export function presetGrant(preset: GrantPreset, overrides: Partial<Grant> = {}): Grant {
  const base = PRESETS[preset]
  const merged: Grant = { ...base, allowedModels: [...base.allowedModels], ...overrides }
  if (Object.keys(overrides).length) merged.preset = overrides.preset ?? 'custom'
  return normalizeGrant(merged)
}

/** Clamp a grant into something consistent (e.g. cannot change mode above its ceiling). */
export function normalizeGrant(g: Grant): Grant {
  const out: Grant = { ...g, allowedModels: [...new Set(g.allowedModels.filter(Boolean))] }
  if (out.modelPolicy === 'list' && out.allowedModels.length === 0) out.modelPolicy = 'locked'
  if (out.mode === 'plan') out.canChangeMode = false // plan is the ceiling: nothing to switch to
  if (out.maxModelCalls !== undefined && !(out.maxModelCalls > 0)) delete out.maxModelCalls
  if (out.maxCostUsd !== undefined && !(out.maxCostUsd > 0)) delete out.maxCostUsd
  return out
}

export type Principal = { kind: 'owner' } | { kind: 'guest'; id: string; name: string; grant: Grant }

export interface SessionRef {
  id: string
  /** Absent = the host owner's session. */
  participantId?: string
  shared?: boolean
}

export type Action =
  | 'session.list'
  | 'session.read'
  | 'session.send'
  | 'session.create'
  | 'session.pause'
  | 'session.setMode'
  | 'session.setModel'
  | 'admin'

export interface Usage {
  /** Sum over every session the guest ran; null costs count as unknown, not zero. */
  modelCalls: number
  costUsd: number | null
}

export type Decision = { ok: true } | { ok: false; reason: string }

const deny = (reason: string): Decision => ({ ok: false, reason })
const allow: Decision = { ok: true }

/**
 * The single permission check. `usage` is the guest's consumption so far (for
 * caps); `model` is the model being requested (for setModel / create).
 */
export function authorize(p: Principal, action: Action, session?: SessionRef, extra: { usage?: Usage; model?: string; mode?: 'plan' | 'build'; now?: number } = {}): Decision {
  if (p.kind === 'owner') return allow
  const g = p.grant
  const now = extra.now ?? Date.now()
  if (g.expiresAt && Date.parse(g.expiresAt) <= now) return deny('this access has expired')
  if (action === 'admin') return deny('only the owner can do that')

  const mine = session?.participantId === p.id
  const sharedOwner = !!session && !session.participantId && !!session.shared

  const overBudget = (): string | null => {
    const u = extra.usage
    if (!u) return null
    if (g.maxModelCalls !== undefined && u.modelCalls >= g.maxModelCalls) return `your limit of ${g.maxModelCalls} model calls is used up`
    if (g.maxCostUsd !== undefined && u.costUsd !== null && u.costUsd >= g.maxCostUsd) return `your spending limit of $${g.maxCostUsd} is reached`
    return null
  }

  switch (action) {
    case 'session.list':
      return g.watch || g.sendShared || g.ownSession ? allow : deny('no access to any session')
    case 'session.read':
      if (mine) return allow
      return sharedOwner && g.watch ? allow : deny('you cannot watch this session')
    case 'session.send': {
      const over = overBudget()
      if (over) return deny(over)
      if (mine) return g.ownSession ? allow : deny('you cannot run your own session')
      return sharedOwner && g.sendShared ? allow : deny('you can only watch this session')
    }
    case 'session.create': {
      if (!g.ownSession) return deny('you cannot open your own session')
      const over = overBudget()
      if (over) return deny(over)
      if (extra.mode === 'build' && g.mode === 'plan') return deny('your agent is read-only (plan mode)')
      if (extra.model !== undefined) return modelDecision(g, extra.model)
      return allow
    }
    case 'session.pause':
      if (mine) return allow
      return sharedOwner && g.canInterrupt ? allow : deny('you cannot interrupt this session')
    case 'session.setMode':
      if (!mine) return deny('you can only change the mode of your own session')
      if (!g.canChangeMode) return deny('the owner locked the mode')
      if (extra.mode === 'build' && g.mode === 'plan') return deny('your agent is read-only (plan mode)')
      return allow
    case 'session.setModel':
      if (!mine) return deny('you can only change the model of your own session')
      return extra.model === undefined ? deny('no model given') : modelDecision(g, extra.model)
  }
}

function modelDecision(g: Grant, model: string): Decision {
  if (g.modelPolicy === 'any') return allow
  if (g.modelPolicy === 'list') return g.allowedModels.includes(model) ? allow : deny(`model "${model}" is not allowed (allowed: ${g.allowedModels.join(', ')})`)
  return deny('the owner locked the model')
}

/* ---------------------------- invites & guests ---------------------------- */

interface InviteRecord {
  id: string
  label: string
  tokenHash: string
  grant: Grant
  createdAt: string
  expiresAt: string
  maxUses: number
  uses: number
  revoked: boolean
}

interface GuestRecord {
  id: string
  name: string
  tokenHash: string
  grant: Grant
  inviteId: string
  createdAt: string
  lastSeenAt: string
  revoked: boolean
}

interface AccessFile {
  version: 1
  invites: InviteRecord[]
  guests: GuestRecord[]
}

const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const newToken = (): string => randomBytes(32).toString('base64url')

export interface InviteOptions {
  label?: string
  /** Lifetime in ms (default 24 h). */
  ttlMs?: number
  /** How many people may use the link (default 1). */
  maxUses?: number
}

/**
 * Persistent invites and guests. Tokens are stored only as SHA-256 hashes: a
 * leaked access.json does not let anyone in. The file is re-read when it
 * changes on disk, so `vara invite` can add an invite while a host runs.
 */
export class AccessStore {
  private data: AccessFile = { version: 1, invites: [], guests: [] }
  private mtime = 0
  private size = -1
  private readonly file: string

  constructor(dir: string = hostDir, private readonly clock: () => number = Date.now) {
    mkdirSync(dir, { recursive: true })
    this.file = join(dir, 'access.json')
    this.refresh(true)
  }

  private refresh(force = false): void {
    if (!existsSync(this.file)) return
    const st = statSync(this.file)
    const m = st.mtimeMs
    // Timestamps can be coarse (and two writes can share one): size must match too,
    // and a file touched in the last 2 s is always re-read.
    if (!force && m === this.mtime && st.size === this.size && Date.now() - m > 2_000) return
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as AccessFile
      if (parsed?.version === 1) this.data = parsed
      this.mtime = m
      this.size = st.size
    } catch {
      /* a half-written file: keep what we have, the next write fixes it */
    }
  }

  private save(): void {
    const tmp = `${this.file}.${process.pid}.tmp`
    writeFileSync(tmp, JSON.stringify(this.data, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameSync(tmp, this.file)
    const st = statSync(this.file)
    this.mtime = st.mtimeMs
    this.size = st.size
  }

  /** Create an invite; the returned token is shown once and never stored. */
  createInvite(grant: Grant, opts: InviteOptions = {}): { id: string; token: string; expiresAt: string } {
    this.refresh()
    const token = newToken()
    const expiresAt = new Date(this.clock() + (opts.ttlMs ?? 24 * 3_600_000)).toISOString()
    const rec: InviteRecord = {
      id: randomUUID().slice(0, 8),
      label: (opts.label ?? '').slice(0, 60),
      tokenHash: sha(token),
      grant: normalizeGrant(grant),
      createdAt: new Date(this.clock()).toISOString(),
      expiresAt,
      maxUses: Math.max(1, opts.maxUses ?? 1),
      uses: 0,
      revoked: false,
    }
    this.data.invites.push(rec)
    this.save()
    return { id: rec.id, token, expiresAt }
  }

  /** Exchange an invite token for a guest identity + access token (shown once). */
  redeem(inviteToken: string, name: string): { guest: Principal & { kind: 'guest' }; accessToken: string } | { error: string } {
    this.refresh()
    const hash = sha(inviteToken)
    const inv = this.data.invites.find((i) => i.tokenHash === hash)
    if (!inv || inv.revoked) return { error: 'invalid invite' }
    if (Date.parse(inv.expiresAt) <= this.clock()) return { error: 'this invite has expired' }
    if (inv.uses >= inv.maxUses) return { error: 'this invite was already used' }
    const clean = name.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'guest'
    const accessToken = newToken()
    const rec: GuestRecord = {
      id: randomUUID().slice(0, 8),
      name: clean,
      tokenHash: sha(accessToken),
      grant: { ...inv.grant, allowedModels: [...inv.grant.allowedModels] },
      inviteId: inv.id,
      createdAt: new Date(this.clock()).toISOString(),
      lastSeenAt: new Date(this.clock()).toISOString(),
      revoked: false,
    }
    inv.uses += 1
    this.data.guests.push(rec)
    this.save()
    return { guest: { kind: 'guest', id: rec.id, name: rec.name, grant: rec.grant }, accessToken }
  }

  /** Resolve a guest access token; null for unknown, revoked or expired. */
  authenticate(accessToken: string): (Principal & { kind: 'guest' }) | null {
    this.refresh()
    const hash = sha(accessToken)
    const g = this.data.guests.find((x) => x.tokenHash === hash)
    if (!g || g.revoked) return null
    if (g.grant.expiresAt && Date.parse(g.grant.expiresAt) <= this.clock()) return null
    return { kind: 'guest', id: g.id, name: g.name, grant: g.grant }
  }

  touch(guestId: string): void {
    const g = this.data.guests.find((x) => x.id === guestId)
    if (!g) return
    const now = this.clock()
    // Persist at most once a minute: reads must not turn into disk writes.
    if (now - Date.parse(g.lastSeenAt) < 60_000) return
    g.lastSeenAt = new Date(now).toISOString()
    this.save()
  }

  getGuest(id: string): (Principal & { kind: 'guest' }) | null {
    this.refresh()
    const g = this.data.guests.find((x) => x.id === id && !x.revoked)
    return g ? { kind: 'guest', id: g.id, name: g.name, grant: g.grant } : null
  }

  listGuests(): Array<{ id: string; name: string; grant: Grant; createdAt: string; lastSeenAt: string; revoked: boolean }> {
    this.refresh()
    return this.data.guests.map(({ tokenHash: _t, inviteId: _i, ...rest }) => rest)
  }

  listInvites(): Array<{ id: string; label: string; grant: Grant; expiresAt: string; uses: number; maxUses: number; revoked: boolean }> {
    this.refresh()
    return this.data.invites.map((i) => ({ id: i.id, label: i.label, grant: i.grant, expiresAt: i.expiresAt, uses: i.uses, maxUses: i.maxUses, revoked: i.revoked }))
  }

  revokeInvite(id: string): boolean {
    this.refresh()
    const i = this.data.invites.find((x) => x.id === id)
    if (!i) return false
    i.revoked = true
    this.save()
    return true
  }

  revokeGuest(id: string): boolean {
    this.refresh()
    const g = this.data.guests.find((x) => x.id === id)
    if (!g) return false
    g.revoked = true
    this.save()
    return true
  }

  /** Change what a guest may do — effective on their very next request. */
  updateGrant(id: string, patch: Partial<Grant>): Grant | null {
    this.refresh()
    const g = this.data.guests.find((x) => x.id === id && !x.revoked)
    if (!g) return null
    g.grant = normalizeGrant({ ...g.grant, ...patch, preset: 'custom' })
    this.save()
    return g.grant
  }
}
