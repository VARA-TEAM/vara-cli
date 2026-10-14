import type { EngineEvent, Session } from '../core/types.js'
import type { Provider } from '../llm/provider.js'
import type { VaraConfig } from '../config/config.js'
import { activeProviderName } from '../config/providers.js'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { createSession, CreateSessionInput } from '../core/session.js'
import { contextStatus, estimateSessionTokens } from '../core/context.js'
import { contextSettingsFor } from '../config/providers.js'
import { findModel } from '../llm/registry.js'
import { cleanTitle, expandMentions } from '../tui/mentions.js'
import { listSessions, loadSession, saveSession, type SessionSummary } from '../core/store.js'
import { SessionRunner } from '../core/runner.js'
import { makeSessionRunner } from '../core/runner-factory.js'
import type { McpHub } from '../mcp/hub.js'
import { scrubAll } from '../security/redact.js'
import { VERSION } from '../version.js'
import { AccessStore, authorize, type Action, type Principal, type SessionRef, type Usage } from './access.js'

/** What clients receive: engine events plus what only the host knows. */
export type HostEvent =
  | EngineEvent
  | { type: 'message'; author: { id: string; name: string; owner: boolean }; text: string }
  | { type: 'revoked' }
  | { type: 'grant'; grant: unknown }

export interface StampedEvent {
  /** Increasing per session; clients resume with `after=<id>`. */
  id: number
  at: string
  event: HostEvent
}

export type Result<T> = { ok: true; value: T } | { ok: false; status: 400 | 403 | 404 | 409; error: string }
const fail = (status: 400 | 403 | 404 | 409, error: string): { ok: false; status: 400 | 403 | 404 | 409; error: string } => ({ ok: false, status, error })

const EVENT_BUFFER = 2_000

interface Live {
  session: Session
  runner: SessionRunner
  events: StampedEvent[]
  nextId: number
  listeners: Set<{ principal: Principal; send: (e: StampedEvent) => void; close: () => void }>
  /** Provider generation the runner was built with. */
  pv: number
}

export interface HostOptions {
  config: () => VaraConfig
  provider: () => Provider
  hub: McpHub
  access: AccessStore
  /** The folder every session (guests' included) works in. */
  cwd: string
  /** Bumps whenever the active provider/model/key changes, so idle runners are rebuilt. */
  providerVersion?: () => number
}

/** A session as a client may see it: no reasoning blocks, everything scrubbed. */
export interface SessionView {
  id: string
  objective: string
  state: string
  stateReason?: string
  kind: string
  mode: string
  model?: string
  intent?: string
  shared: boolean
  participant?: { id: string; name: string }
  usage: { turns: number; modelCalls: number; toolCalls: number; costUsd: number | null; costPartial: boolean; inputTokens: number | null; outputTokens: number | null }
  requirements: string[]
  /** Requirement numbers ("1", "2"…) the last accepted completion covered. */
  verified: string[]
  /** What the REQUESTING principal may do here — the UI shows controls from this, never from guesses. */
  can: { send: boolean; pause: boolean; setMode: boolean; setModel: boolean; manage: boolean }
  updatedAt: string
  transcript: Array<{ role: string; content: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; toolName?: string; toolCallId?: string; at: string }>
}

function refOf(s: Pick<Session, 'id' | 'participant' | 'shared'>): SessionRef {
  return { id: s.id, ...(s.participant ? { participantId: s.participant.id } : {}), shared: s.shared === true }
}

/**
 * Hosts sessions for the owner and their guests. Every public method takes the
 * acting Principal and goes through `authorize()` — the HTTP layer adds
 * authentication, but permissions live here so no front end can bypass them.
 */
export class VaraHost {
  private live = new Map<string, Live>()

  constructor(private readonly opts: HostOptions) {}

  get access(): AccessStore {
    return this.opts.access
  }

  /* ---------- loading ---------- */

  private async load(id: string): Promise<Live | null> {
    const existing = this.live.get(id)
    if (existing) return existing
    const session = await loadSession(id)
    if (!session) return null
    return this.adopt(session)
  }

  private adopt(session: Session): Live {
    const live: Live = { session, runner: null as never, events: [], nextId: 1, listeners: new Set(), pv: this.opts.providerVersion?.() ?? 0 }
    live.runner = this.newRunner(live)
    this.live.set(session.id, live)
    return live
  }

  private newRunner(live: Live): SessionRunner {
    return makeSessionRunner({
      session: live.session,
      provider: this.opts.provider,
      config: this.opts.config,
      hub: this.opts.hub,
      onEvent: (e) => this.publish(live, e),
    })
  }

  /** An idle session picks up a provider/model/key change before its next turn. */
  private refresh(live: Live): void {
    const v = this.opts.providerVersion?.() ?? 0
    if (live.pv === v || live.runner.isRunning) return
    live.runner = this.newRunner(live)
    live.pv = v
  }

  private publish(live: Live, event: HostEvent): void {
    const stamped: StampedEvent = { id: live.nextId++, at: new Date().toISOString(), event }
    live.events.push(stamped)
    if (live.events.length > EVENT_BUFFER) live.events.splice(0, live.events.length - EVENT_BUFFER)
    for (const l of live.listeners) {
      // The model's private reasoning stream is for the owner only.
      if (event.type === 'thinking' && l.principal.kind !== 'owner') continue
      try {
        l.send(stamped)
      } catch {
        live.listeners.delete(l)
      }
    }
  }

  /* ---------- usage ---------- */

  /** What a guest has consumed across everything they ran. Unknown costs stay unknown. */
  async guestUsage(guestId: string): Promise<Usage> {
    const rows = await this.summaries()
    let calls = 0
    let cost: number | null = 0
    for (const r of rows) {
      if (r.participant?.id !== guestId) continue
      calls += r.modelCalls
      if (r.modelCalls > 0 && r.costUsd === null) cost = null
      else if (cost !== null) cost += r.costUsd ?? 0
    }
    return { modelCalls: calls, costUsd: cost }
  }

  private async summaries(): Promise<SessionSummary[]> {
    const stored = await listSessions()
    // Live sessions are fresher than their last snapshot on disk.
    return stored.map((row) => {
      const l = this.live.get(row.id)
      if (!l) return row
      const s = l.session
      return {
        ...row,
        state: s.state,
        costUsd: s.usage.costUsd ?? null,
        unpricedCalls: s.usage.unpricedCalls ?? 0,
        modelCalls: s.usage.modelCalls,
        turns: s.usage.turns,
        mode: s.config.mode,
        model: s.config.model,
        intent: s.intent,
        shared: s.shared === true,
      }
    })
  }

  private async usageFor(p: Principal): Promise<Usage | undefined> {
    return p.kind === 'guest' ? this.guestUsage(p.id) : undefined
  }

  /* ---------- queries ---------- */

  async list(p: Principal): Promise<Result<SessionSummary[]>> {
    const d = authorize(p, 'session.list')
    if (!d.ok) return fail(403, d.reason)
    const all = await this.summaries()
    const rows = all.filter((r) => authorize(p, 'session.read', { id: r.id, ...(r.participant ? { participantId: r.participant.id } : {}), shared: r.shared }).ok)
    return { ok: true, value: rows.map((r) => ({ ...r, objective: cleanTitle(scrubAll(r.objective)) })) }
  }

  async get(p: Principal, id: string): Promise<Result<SessionView>> {
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    const d = authorize(p, 'session.read', refOf(live.session))
    // Do not reveal that another guest's session exists.
    if (!d.ok) return fail(404, 'no such session')
    return { ok: true, value: this.view(live.session, p) }
  }

  private view(s: Session, p: Principal): SessionView {
    const ref = refOf(s)
    return {
      id: s.id,
      objective: cleanTitle(scrubAll(s.config.objective)),
      state: s.state,
      ...(s.stateReason ? { stateReason: scrubAll(s.stateReason) } : {}),
      kind: s.config.kind,
      mode: s.config.mode,
      ...(s.config.model ? { model: s.config.model } : {}),
      ...(s.intent ? { intent: s.intent } : {}),
      shared: s.shared === true,
      ...(s.participant ? { participant: s.participant } : {}),
      usage: {
        turns: s.usage.turns,
        modelCalls: s.usage.modelCalls,
        toolCalls: s.usage.toolCalls,
        costUsd: s.usage.costUsd,
        costPartial: s.usage.costPartial,
        inputTokens: s.usage.inputTokens,
        outputTokens: s.usage.outputTokens,
      },
      requirements: (s.activeRequirements ?? []).map((r) => cleanTitle(scrubAll(r))),
      verified: s.state === 'completed' ? (s.completionClaim?.verifiedRequirements ?? []) : [],
      can: {
        send: authorize(p, 'session.send', ref).ok,
        pause: authorize(p, 'session.pause', ref).ok,
        setMode: authorize(p, 'session.setMode', ref, { mode: 'plan' }).ok,
        setModel: p.kind === 'owner' || authorize(p, 'session.setModel', ref, { model: p.grant.allowedModels[0] ?? '' }).ok,
        manage: p.kind === 'owner',
      },
      updatedAt: s.updatedAt,
      transcript: s.transcript
        .filter((m) => !(m.role === 'user' && /^\[(ENGINE|STATE|SYSTEM|BUDGET|FOLLOW-UP INSTRUCTION)/.test(m.content)))
        .map((m) => ({
          role: m.role,
          content: scrubAll(m.content),
          ...(m.toolCalls ? { toolCalls: m.toolCalls.map((c) => ({ ...c, arguments: scrubAll(c.arguments) })) } : {}),
          ...(m.toolName ? { toolName: m.toolName } : {}),
          ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
          at: m.at,
        })),
    }
  }

  /** What the page header shows: version, folder name (not the full path for guests), provider. */
  info(_p: Principal): { version: string; folder: string; provider: string; model: string } {
    const cfg = this.opts.config()
    const folder = this.opts.cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
    return { version: VERSION, folder, provider: activeProviderName(cfg), model: cfg.provider.model }
  }

  /** Models a principal may choose (names only — never keys). */
  models(p: Principal): { provider: string; current: string; allowed: string[] | 'any' } {
    const cfg = this.opts.config()
    const entry = cfg.providers[activeProviderName(cfg)]
    const all = Object.keys(entry?.models ?? {})
    if (p.kind === 'owner' || p.grant.modelPolicy === 'any') return { provider: activeProviderName(cfg), current: cfg.provider.model, allowed: p.kind === 'owner' ? all : 'any' }
    return { provider: activeProviderName(cfg), current: cfg.provider.model, allowed: p.grant.modelPolicy === 'list' ? p.grant.allowedModels : [cfg.provider.model] }
  }

  /* ---------- commands ---------- */

  async create(p: Principal, input: { message: string; mode?: 'plan' | 'build'; kind?: 'task' | 'goal' | 'auto'; model?: string }): Promise<Result<SessionView>> {
    const typed = input.message.trim()
    if (!typed) return fail(400, 'write a message first')
    // Only the owner may pull host files into a prompt with @path.
    const text = p.kind === 'owner' ? (await expandMentions(typed, this.opts.cwd)).text : typed
    const cfg = this.opts.config()
    // A guest limited to a model list starts on the first allowed model, not the owner's pick.
    const model = input.model ?? (p.kind === 'guest' && p.grant.modelPolicy === 'list' ? p.grant.allowedModels[0] : undefined) ?? cfg.provider.model
    // Guests: mode capped by their grant, model by policy, folder is always the host's.
    const wantMode = input.mode ?? (p.kind === 'guest' ? p.grant.mode : cfg.agent.defaultMode)
    const modelAsked = input.model !== undefined || (p.kind === 'guest' && p.grant.modelPolicy === 'list')
    const d = authorize(p, 'session.create', undefined, { mode: wantMode, ...(modelAsked ? { model } : {}), ...(await this.usageOf(p)) })
    if (!d.ok) return fail(403, d.reason)

    const auto = (input.kind ?? 'auto') === 'auto'
    const parsed = CreateSessionInput.parse({
      kind: auto ? 'task' : input.kind,
      mode: wantMode,
      objective: text,
      cwd: this.opts.cwd,
      verifyCommand: cfg.defaultVerifyCommand || undefined,
      model,
      auto,
      allowPublish: p.kind === 'owner' ? undefined : false,
    })
    const session = createSession(parsed, cfg)
    if (p.kind === 'guest') session.participant = { id: p.id, name: p.name }
    await saveSession(session)
    const live = this.adopt(session)
    this.publish(live, { type: 'message', author: authorOf(p), text: typed })
    void this.run(live)
    return { ok: true, value: this.view(session, p) }
  }

  private async usageOf(p: Principal): Promise<{ usage?: Usage }> {
    const u = await this.usageFor(p)
    return u ? { usage: u } : {}
  }

  async send(p: Principal, id: string, text: string): Promise<Result<{ queued: boolean }>> {
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    const ref = refOf(live.session)
    if (!authorize(p, 'session.read', ref).ok) return fail(404, 'no such session')
    const typed = text.trim()
    if (!typed) return fail(400, 'write a message first')
    const d = authorize(p, 'session.send', ref, await this.usageOf(p))
    if (!d.ok) return fail(403, d.reason)
    const message = p.kind === 'owner' ? (await expandMentions(typed, this.opts.cwd)).text : typed
    this.refresh(live)

    if (p.kind === 'guest') this.enforceGrant(live, p)
    // Others in a shared session must be able to tell who said what — the model too.
    const delivered = p.kind === 'guest' && ref.shared && !ref.participantId ? `[from ${p.name}] ${message}` : message
    this.publish(live, { type: 'message', author: authorOf(p), text: typed })
    const wasRunning = live.runner.isRunning
    live.runner.send(delivered)
    if (!wasRunning) void this.run(live)
    return { ok: true, value: { queued: wasRunning } }
  }

  /** A grant can be tightened while a session exists: re-apply it before the next turn. */
  private enforceGrant(live: Live, p: Principal & { kind: 'guest' }): void {
    const g = this.opts.access.getGuest(p.id)?.grant ?? p.grant
    const s = live.session
    if (s.participant?.id !== p.id) return
    if (g.mode === 'plan' && s.config.mode === 'build') s.config.mode = 'plan'
    if (g.modelPolicy === 'list' && s.config.model && !g.allowedModels.includes(s.config.model)) {
      s.config.model = g.allowedModels[0]
      live.runner = this.newRunner(live)
    }
  }

  private async run(live: Live): Promise<void> {
    try {
      await live.runner.start()
    } catch (err) {
      this.publish(live, { type: 'error', message: scrubAll((err as Error).message) })
    }
  }

  async pause(p: Principal, id: string): Promise<Result<true>> {
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    const ref = refOf(live.session)
    if (!authorize(p, 'session.read', ref).ok) return fail(404, 'no such session')
    const d = authorize(p, 'session.pause', ref)
    if (!d.ok) return fail(403, d.reason)
    live.runner.pause()
    return { ok: true, value: true }
  }

  async setMode(p: Principal, id: string, mode: 'plan' | 'build'): Promise<Result<true>> {
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    const ref = refOf(live.session)
    if (!authorize(p, 'session.read', ref).ok) return fail(404, 'no such session')
    const d = authorize(p, 'session.setMode', ref, { mode })
    if (!d.ok) return fail(403, d.reason)
    live.session.config.mode = mode
    await saveSession(live.session)
    return { ok: true, value: true }
  }

  async setModel(p: Principal, id: string, model: string): Promise<Result<true>> {
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    const ref = refOf(live.session)
    if (!authorize(p, 'session.read', ref).ok) return fail(404, 'no such session')
    const d = authorize(p, 'session.setModel', ref, { model })
    if (!d.ok) return fail(403, d.reason)
    live.runner.pause()
    live.session.config.model = model
    live.runner = this.newRunner(live)
    await saveSession(live.session)
    return { ok: true, value: true }
  }

  /** Owner: open or close a session to guests. */
  async share(p: Principal, id: string, shared: boolean): Promise<Result<true>> {
    const d = authorize(p, 'admin')
    if (!d.ok) return fail(403, d.reason)
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    live.session.shared = shared
    await saveSession(live.session)
    // Closing a session to guests cuts off everyone watching it, except its own participant.
    if (!shared) {
      for (const l of [...live.listeners]) {
        if (l.principal.kind === 'guest' && live.session.participant?.id !== l.principal.id) {
          l.close()
          live.listeners.delete(l)
        }
      }
    }
    return { ok: true, value: true }
  }

  /* ---------- live events ---------- */

  /**
   * Subscribe to a session's events. Returns the backlog after `after` and a
   * way to stop. Guests are re-checked by the HTTP layer on every connect.
   */
  async subscribe(
    p: Principal,
    id: string,
    after: number,
    handlers: { send: (e: StampedEvent) => void; close: () => void },
  ): Promise<Result<{ backlog: StampedEvent[]; unsubscribe: () => void }>> {
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    if (!authorize(p, 'session.read', refOf(live.session)).ok) return fail(404, 'no such session')
    const listener = { principal: p, ...handlers }
    live.listeners.add(listener)
    const backlog = live.events.filter((e) => e.id > after && !(e.event.type === 'thinking' && p.kind !== 'owner'))
    return { ok: true, value: { backlog, unsubscribe: () => live.listeners.delete(listener) } }
  }

  /**
   * A guest revoked from another process (`vara guests revoke`) has no live
   * request to fail, so look for their agents and stop them.
   */
  sweepRevoked(): void {
    for (const live of this.live.values()) {
      const pid = live.session.participant?.id
      if (pid && !this.opts.access.getGuest(pid) && live.runner.isRunning) {
        live.runner.pause()
        this.disconnectGuest(pid)
      }
    }
  }

  /** Cut a revoked guest off every live stream right now. */
  disconnectGuest(guestId: string): void {
    for (const live of this.live.values()) {
      for (const l of [...live.listeners]) {
        if (l.principal.kind === 'guest' && l.principal.id === guestId) {
          try {
            l.send({ id: live.nextId++, at: new Date().toISOString(), event: { type: 'revoked' } })
          } catch {
            /* already gone */
          }
          l.close()
          live.listeners.delete(l)
        }
      }
    }
    // A revoked guest's agents stop too.
    for (const live of this.live.values()) if (live.session.participant?.id === guestId) live.runner.pause()
  }

  /* ---------- owner overview ---------- */

  /** Everyone, with what they used and what they are doing — for the owner. */
  async overview(p: Principal): Promise<Result<{ guests: Array<{ id: string; name: string; preset: string; lastSeenAt: string; revoked: boolean; sessions: number; running: number; modelCalls: number; costUsd: number | null }>; sessions: SessionSummary[] }>> {
    const d = authorize(p, 'admin')
    if (!d.ok) return fail(403, d.reason)
    const sessions = await this.summaries()
    const guests = this.opts.access.listGuests().map((g) => {
      const mine = sessions.filter((s) => s.participant?.id === g.id)
      let cost: number | null = 0
      for (const s of mine) {
        if (s.modelCalls > 0 && s.costUsd === null) cost = null
        else if (cost !== null) cost += s.costUsd ?? 0
      }
      return {
        id: g.id,
        name: g.name,
        preset: g.grant.preset,
        lastSeenAt: g.lastSeenAt,
        revoked: g.revoked,
        sessions: mine.length,
        running: mine.filter((s) => s.state === 'running').length,
        modelCalls: mine.reduce((n, s) => n + s.modelCalls, 0),
        costUsd: cost,
      }
    })
    return { ok: true, value: { guests, sessions: sessions.map((s) => ({ ...s, objective: cleanTitle(scrubAll(s.objective)) })) } }
  }

  /* ---------- per-session extras (what /cost, /context, /status, /evidence, /export, /stop, /kind show) ---------- */

  async insights(p: Principal, id: string): Promise<Result<unknown>> {
    const live = await this.load(id)
    if (!live || !authorize(p, 'session.read', refOf(live.session)).ok) return fail(404, 'no such session')
    const s = live.session
    const u = s.usage
    const sv = s.savings ?? { compactedChars: 0, dedupedReads: 0, cheapCalls: 0, subagents: 0 }
    const cached = u.cachedInputTokens
    const total = (u.inputTokens ?? 0) + (cached ?? 0)
    const pricing = findModel(s.config.model ?? '')?.pricing
    const cacheUsd = pricing && cached ? (cached / 1e6) * (pricing.inputPer1M - (pricing.cachedInputPer1M ?? pricing.inputPer1M)) : null
    const compactTokens = Math.round(sv.compactedChars / 4)
    const compactUsd = pricing ? (compactTokens / 1e6) * pricing.inputPer1M * Math.max(1, u.turns / 2) : null
    const cfg = this.opts.config()
    const ctx = contextStatus(s, contextSettingsFor(cfg, s.config.model ?? cfg.provider.model))
    const used = estimateSessionTokens(s)
    return {
      ok: true,
      value: {
        cost: {
          costUsd: u.costUsd,
          costPartial: u.costPartial,
          modelCalls: u.modelCalls,
          toolCalls: u.toolCalls,
          inputTokens: u.inputTokens,
          cachedTokens: cached,
          outputTokens: u.outputTokens,
          cacheHitPercent: cached !== null && total > 0 ? Math.round(((cached ?? 0) / total) * 100) : null,
        },
        savings: { cacheUsd, compactedTokens: compactTokens, compactUsd, dedupedReads: sv.dedupedReads, cheapCalls: sv.cheapCalls, subagents: sv.subagents },
        context: {
          windowTokens: ctx.windowTokens,
          source: ctx.source,
          requestBudgetTokens: ctx.requestBudgetTokens,
          reservedOutput: ctx.maxOutputTokens,
          usedTokens: used,
          percent: ctx.requestBudgetTokens ? Math.min(100, Math.round((used / ctx.requestBudgetTokens) * 100)) : 0,
        },
        budget: {
          turns: u.turns,
          maxTurns: s.config.budget.maxTurns,
          modelCalls: u.modelCalls,
          maxModelCalls: s.config.budget.maxModelCalls,
          maxMinutes: Math.round(s.config.budget.maxDurationMs / 60_000),
          evidence: s.evidence.length,
        },
        evidence: s.evidence.slice(-20).map((e) => ({
          at: e.at,
          kind: e.kind,
          ok: e.ok,
          ...(e.command ? { command: scrubAll(e.command) } : {}),
          ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
          ...(e.output ? { output: scrubAll(e.output).slice(0, 600) } : {}),
          ...(e.files ? { files: e.files.slice(0, 30) } : {}),
        })),
      },
    }
  }

  /** The conversation as a markdown document (no hidden reasoning, everything scrubbed). */
  async exportMarkdown(p: Principal, id: string): Promise<Result<{ filename: string; markdown: string }>> {
    const live = await this.load(id)
    if (!live || !authorize(p, 'session.read', refOf(live.session)).ok) return fail(404, 'no such session')
    const s = live.session
    const md = [`# ${cleanTitle(scrubAll(s.config.objective))}`, '', `session ${s.id} · ${s.config.model ?? ''} · ${s.state}`, '']
    for (const m of s.transcript) {
      if (m.role === 'user' && /^\[(ENGINE|SYSTEM|STATE|BUDGET|FOLLOW-UP INSTRUCTION)/.test(m.content)) continue
      if (m.role === 'user') md.push('## You', '', scrubAll(m.content.split('\n\n[attached files]')[0]!), '')
      else if (m.role === 'assistant' && m.content.trim()) md.push('## VARA', '', scrubAll(m.content), '')
      for (const c of m.toolCalls ?? []) md.push(`> tool: \`${c.name}\` ${scrubAll(c.arguments).slice(0, 200)}`, '')
    }
    return { ok: true, value: { filename: `vara-${s.id}.md`, markdown: md.join('\n') } }
  }

  /** End a session for good (the terminal's /stop, without quitting the host). */
  async stop(p: Principal, id: string): Promise<Result<true>> {
    const live = await this.load(id)
    if (!live || !authorize(p, 'session.read', refOf(live.session)).ok) return fail(404, 'no such session')
    const d = authorize(p, 'session.pause', refOf(live.session))
    if (!d.ok) return fail(403, d.reason)
    live.runner.pause()
    live.session.state = 'stopped'
    live.session.stateReason = 'Stopped by the user.'
    await saveSession(live.session)
    this.publish(live, { type: 'state', state: 'stopped', reason: 'Stopped by the user.' })
    return { ok: true, value: true }
  }

  /** Owner: switch a session between a bounded task and an ongoing goal. */
  async setKind(p: Principal, id: string, kind: 'task' | 'goal'): Promise<Result<true>> {
    const d = authorize(p, 'admin')
    if (!d.ok) return fail(403, d.reason)
    const live = await this.load(id)
    if (!live) return fail(404, 'no such session')
    const cfg = this.opts.config()
    live.session.config.auto = false
    live.session.config.kind = kind
    live.session.config.budget = kind === 'task' ? cfg.budgets.task : cfg.budgets.goal
    await saveSession(live.session)
    return { ok: true, value: true }
  }

  private fileCache: { at: number; files: string[] } | null = null

  /** Owner: project files matching a fragment, for @-mentions. Skips dependency and build folders. */
  async files(p: Principal, query: string): Promise<Result<string[]>> {
    const d = authorize(p, 'admin')
    if (!d.ok) return fail(403, d.reason)
    if (!this.fileCache || Date.now() - this.fileCache.at > 15_000) {
      const out: string[] = []
      const skip = new Set(['node_modules', 'dist', 'build', 'out', 'target', '__pycache__', 'coverage', 'venv'])
      const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (out.length >= 20_000 || depth > 8) return
        let entries
        try {
          entries = await readdir(dir, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          if (out.length >= 20_000) return
          if (e.isDirectory()) {
            if (!skip.has(e.name) && !e.name.startsWith('.')) await walk(join(dir, e.name), `${rel}${e.name}/`, depth + 1)
          } else if (e.isFile()) out.push(`${rel}${e.name}`)
        }
      }
      await walk(this.opts.cwd, '', 0)
      this.fileCache = { at: Date.now(), files: out }
    }
    const q = query.trim().toLowerCase().slice(0, 100)
    const all = this.fileCache.files
    const base = (f: string): string => f.slice(f.lastIndexOf('/') + 1).toLowerCase()
    const hits = q ? all.filter((f) => f.toLowerCase().includes(q)) : [...all]
    const rank = (f: string): number => {
      const i = base(f).indexOf(q)
      return i < 0 ? 999 : i
    }
    hits.sort((a, b) => rank(a) - rank(b) || a.length - b.length)
    return { ok: true, value: hits.slice(0, 30) }
  }

  async closeAll(): Promise<void> {
    for (const live of this.live.values()) {
      live.runner.pause()
      for (const l of live.listeners) l.close()
      try {
        await saveSession(live.session)
      } catch {
        /* shutting down */
      }
    }
    this.live.clear()
  }
}

function authorOf(p: Principal): { id: string; name: string; owner: boolean } {
  return p.kind === 'owner' ? { id: 'owner', name: 'owner', owner: true } : { id: p.id, name: p.name, owner: false }
}

export type { Action }
