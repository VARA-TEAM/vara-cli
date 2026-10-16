import { randomUUID } from 'node:crypto'
import type {
  Budget,
  EngineEvent,
  EvidenceRecord,
  FollowUp,
  Session,
  SessionIntent,
  SessionKind,
  SessionState,
  TranscriptMessage,
} from './types.js'
import { classifyIntent, isWorkIntent } from './intent.js'
import { skillIndex, type Skill } from './skills.js'
import { describePolicy, type ModePolicy } from './modes.js'
import { resolveImages } from './attachments.js'
import type { AdminPort } from './selfmanage.js'
import type { ModelMessage, Provider } from '../llm/provider.js'
import type { NormalizedUsage } from '../llm/usage.js'
import { emptyUsage } from '../llm/usage.js'
import { computeCost, aggregateModelCalls, type AggregatedUsage } from '../llm/cost.js'
import type { ModelCallRecord } from './types.js'
import { buildStateNote, buildSystemPrompt } from './prompt.js'
import { authorize } from '../tools/permissions.js'
import { findTool, toolDefinitions, toolsFor } from '../tools/registry.js'
import type { Tool, ToolResult } from '../tools/types.js'
import { createSession, CreateSessionInput } from './session.js'
import { clampLimits, planSwarm, runSwarm, type SwarmLimits, type SwarmTask, type SwarmTaskInput, type TaskStatus as SwarmStatus } from './swarm.js'
import { stat } from 'node:fs/promises'
import { OUTLINE_MARK } from '../tools/fs-tools.js'
import { resolve as resolvePath } from 'node:path'
import type { ThinkLevel } from '../llm/capabilities.js'
import { runVerificationCommand } from '../tools/shell-tool.js'
import type { ToolContext } from '../tools/types.js'
import { getSecretsForScope } from '../security/vault.js'
import { clearSecrets, registerSecret, scrubAll } from '../security/redact.js'
import { appendEvent, saveSession } from './store.js'
import { contextStatus, estimateTokens, type ContextSettings } from './context.js'
import { DEFAULT_CONFIG } from '../config/config.js'
import { decideRoute, DEFAULT_ROUTER, tierRank, type RouteDecision, type RouterSettings, type Tier } from './router.js'
import { compressToolOutput, contentHash, OutputStore, shrinkForCompaction } from './outputs.js'
import { planSummary, renderForSummary, SUMMARY_SYSTEM, summaryMessage } from './summarize.js'
import { naiveInputTokens, recordFromCall, type LimitsConfig, type UsageMeter, DEFAULT_LIMITS } from './usage-meter.js'
import { invalidateRepoMap } from './repomap.js'
import { sessionDir } from '../config/paths.js'
import { join as joinPath } from 'node:path'

const MAX_TOOL_OUTPUT_CHARS = 12_000
/** Identical consecutive calls tolerated before the run is paused (the 3rd already warns the model). */
const LOOP_HARD_STOP = 5
/** Control tools that cannot change files, so they do not invalidate a verification result. */
const NON_MUTATING = new Set(['complete', 'ask_user', 'escalate', 'skill', 'todo'])
/** Read-only tools whose calls in one turn may run side by side (R4). */
const PARALLEL_SAFE = new Set(['read_file', 'list_dir', 'glob', 'grep', 'git_status', 'git_diff', 'git_log', 'repo_map', 'read_symbol', 'tool_output'])

/**
 * Some models emit tool arguments whose JSON is truncated mid-stream (a common
 * trait of small/fast models). Before giving up, try to salvage it by closing
 * any dangling string/object/array. Returns null when it cannot be repaired.
 */
export function repairTruncatedJson(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    const direct = JSON.parse(trimmed) as unknown
    return direct && typeof direct === 'object' && !Array.isArray(direct)
      ? (direct as Record<string, unknown>)
      : null
  } catch {
    /* fall through to repair */
  }

  // Strip markdown code fences if the model wrapped it in ```json ... ```
  let cleaned = trimmed
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim()
    try {
      const parsed = JSON.parse(cleaned) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null
    } catch {
      /* continue */
    }
  }

  if (!cleaned.startsWith('{')) {
    return null
  }

  const stack: string[] = []
  let inString = false
  let escaped = false
  for (const ch of cleaned) {
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') stack.push('}')
    else if (ch === '[') stack.push(']')
    else if (ch === '}' || ch === ']') {
      if (stack.length && stack[stack.length - 1] === ch) stack.pop()
      else if (stack.length) stack.pop()
    }
  }

  let candidate = cleaned
  if (inString) candidate += '"'

  candidate = candidate.trimEnd()
  // Clean dangling comma outside strings: e.g. {"a": 1, -> {"a": 1
  candidate = candidate.replace(/,\s*$/, '')
  // Clean dangling key or colon: e.g. {"a": 1, "b": -> {"a": 1, "b": ""
  if (/:\s*$/.test(candidate)) {
    candidate += '""'
  }

  while (stack.length) candidate += stack.pop()

  try {
    const repaired = JSON.parse(candidate) as unknown
    return repaired && typeof repaired === 'object' && !Array.isArray(repaired)
      ? (repaired as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}
/** Consecutive turns that produce neither tool calls nor evidence before we pause (goal stall detection). */
const STALL_LIMIT = 5
/** The engine refuses a completion claim at most this many times before pausing for the user. */
const MAX_FAILED_CLAIMS = 3
/** Messages at the end of the conversation that are never compacted. */
const KEEP_RECENT_MESSAGES = 8
/** Tool outputs shorter than this are not worth compacting. */
const COMPACT_THRESHOLD_CHARS = 1_200
/** Rough context cost of one attached image (providers charge ~1-2k tokens). */
const IMAGE_TOKENS = 1_600

export interface EngineOptions {
  session: Session
  provider: Provider
  model?: string
  /** Live context settings for the model in use (re-read every turn). */
  contextSettings?: () => ContextSettings
  /** Skills the agent may load (resolved once per run). */
  loadSkills?: () => Promise<Skill[]>
  /** Budget for a kind, from the user's config (defaults otherwise). */
  budgetFor?: (kind: SessionKind) => Budget
  /** Cheaper model for a kind of turn (chat / question / sub-agent); undefined = the session model. */
  routeModel?: (kind: 'chat' | 'question' | 'subagent') => string | undefined
  /** Reasoning level for the model about to be used; only consulted on work turns. */
  thinkingLevel?: (model: string) => ThinkLevel | undefined
  /** Restrictions of the session's custom mode (read live each turn; only ever narrows plan/build). */
  modePolicy?: () => ModePolicy | undefined
  /** Whether a model can view images; without it attached images are described as not viewable. */
  vision?: (model: string) => boolean
  /** Swarm limits from the user's config (read live; can only lower the built-in ceilings). */
  swarm?: () => Partial<SwarmLimits> | undefined
  /** The agent may change its own setup through this port, after the user approves each change. */
  admin?: AdminPort
  /** A person is watching and can answer approval requests (false for headless runs). */
  interactive?: boolean
  /** Tools from connected MCP servers (read live each turn). */
  extraTools?: () => Tool<never>[]
  /** The memory block for the system prompt (core/memory.ts); empty when memory is off or has no notes. Owner sessions only: sub-agents do not get it. */
  memoryBlock?: () => string
  /** One line per connected MCP server, for the prompt. */
  mcpSummary?: () => string
  /** Do not persist this session or its events (sub-agents). */
  ephemeral?: boolean
  /** Sub-agent depth: 0 = the user's session. Sub-agents cannot delegate. */
  depth?: number
  /** Run exactly this intent (sub-agents). */
  forceIntent?: SessionIntent
  /** Model router settings, read live every turn (see core/router.ts). Absent = v0.4.0 behaviour. */
  router?: () => RouterSettings
  /** A provider other than the session's, by name (tiers may live on another provider). */
  providerFor?: (name: string) => Provider | undefined
  /** Usage meter: every call is recorded; limits and eco mode read from it. */
  meter?: UsageMeter
  /** The user's limit (read live). */
  limits?: () => LimitsConfig
  /** Cost-engine switches (read live). */
  costSettings?: () => { summarize: boolean; toolOutputChars: number; smartRead: boolean; /** false = keep the v0.4.0 cut (benchmarks/ablation) */ compress?: boolean }
  onEvent?: (event: EngineEvent) => void
}

/**
 * The single execution engine. Task and Goal differ only in completion policy
 * and budget; the loop, tools, permissions, persistence and verification are shared.
 */
export class Engine {
  readonly session: Session
  private readonly provider: Provider
  private readonly model?: string
  private readonly contextSettings?: () => ContextSettings
  private readonly loadSkills?: () => Promise<Skill[]>
  private readonly budgetFor?: (kind: SessionKind) => Budget
  private skills: Skill[] = []
  private lastModelUsed = ''
  private readonly routeModel?: EngineOptions['routeModel']
  private readonly thinkingLevel?: EngineOptions['thinkingLevel']
  private readonly vision?: EngineOptions['vision']
  private readonly extraTools?: EngineOptions['extraTools']
  private readonly mcpSummary?: EngineOptions['mcpSummary']
  private readonly ephemeral: boolean
  private readonly depth: number
  private readonly forceIntent?: SessionIntent
  private readonly options: EngineOptions
  private children: Engine[] = []
  /** `delegate` calls so far in this session (numbers a swarm for the UI). */
  private swarmCount = 0
  /** Running sub-agents by task id, so the user can cancel one. */
  private childByTask = new Map<string, Engine>()
  private cancelledTasks = new Set<string>()
  private swarmCancelled = false
  /** Approvals waiting for the user: id → how to answer. */
  private approvals = new Map<string, (a: { approved: boolean; note?: string }) => void>()
  /** Files already read in full: path → mtime + the tool call that holds the content. */
  private readCache = new Map<string, { mtimeMs: number; callId: string }>()
  /** What the current run is about; decides prompt, tools and when a turn ends. */
  private intent: SessionIntent = 'task'
  private readonly emit: (event: EngineEvent) => void
  private abort: AbortController | null = null
  /** Set by stop(): a pause between two model calls (a tool running) must not be forgotten when the next call starts. */
  private stopped = false
  private env: Record<string, string> = {}
  private followUpsToInject: FollowUp[] = []
  private failedClaims = 0
  private turnsWithoutProgress = 0
  /** Consecutive failures per tool — two in a row forces a strategy change, not a retry. */
  private toolFailureStreak = new Map<string, number>()
  /** Signature of the last tool call to detect repetitive loops. */
  private lastToolSignature = ''
  private identicalToolStreak = 0
  /** Highest budget warning percent already fired (70/80/90). */
  private lastBudgetWarning = 0
  /** Full text of shortened tool outputs, retrievable with the tool_output tool. */
  private readonly outputStore: OutputStore
  private readonly outputHashes = new Map<string, string>()
  /** Router memory. */
  private previousTier?: Tier
  private recentDesired: Tier[] = []
  private lastTurnTools: { tools: string[]; allOk: boolean } | null = null
  private verificationFailedNext = false
  private freshObjective = true
  private currentProvider: Provider
  private lastRoute?: { tier: Tier; phase: string }
  private lastReasoningModel?: string
  private lastOverheadChars = 0
  /** Bumped when a tool that can change things succeeds; verification is skipped while it is unchanged. */
  private mutationEpoch = 0
  private lastVerify?: { epoch: number; command: string; run: { exitCode: number | null; output: string } }
  private lastLimitLevel = 0
  private ecoActive = false

  constructor(options: EngineOptions) {
    this.session = options.session
    this.provider = options.provider
    this.model = options.model
    this.contextSettings = options.contextSettings
    this.loadSkills = options.loadSkills
    this.budgetFor = options.budgetFor
    this.routeModel = options.routeModel
    this.thinkingLevel = options.thinkingLevel
    this.vision = options.vision
    this.extraTools = options.extraTools
    this.mcpSummary = options.mcpSummary
    this.ephemeral = options.ephemeral ?? false
    this.depth = options.depth ?? 0
    this.forceIntent = options.forceIntent
    this.options = options
    this.currentProvider = options.provider
    this.outputStore = new OutputStore(options.ephemeral ? null : joinPath(sessionDir(options.session.id), 'outputs'))
    // Wrap the frontend callback so every meaningful event also lands in the
    // append-only audit log (events.jsonl). High-frequency text deltas are
    // excluded — the full text lives in the session transcript — and log
    // failures are swallowed: accounting must never break execution.
    this.emit = (event: EngineEvent) => {
      options.onEvent?.(event)
      // 'text' and 'thinking' are high-frequency transient streams — excluded
      // (the full text lives in the transcript; reasoning is not evidence).
      if (!this.ephemeral && event.type !== 'text' && event.type !== 'thinking') void appendEvent(this.session.id, event).catch(() => {})
    }
  }

  /** Queue a follow-up. Applied at the start of the next turn (a safe point). */
  queueFollowUp(text: string): void {
    const followUp: FollowUp = { id: randomUUID(), text, at: new Date().toISOString() }
    this.session.followUps.push(followUp)
    this.followUpsToInject.push(followUp)
  }

  /**
   * Ask the user to approve a change to the agent's own setup. The run waits
   * (state `waiting_user`) until someone answers; stopping the run declines it.
   */
  private requestApproval(req: { action: string; title: string; detail: string }): Promise<{ approved: boolean; note?: string }> {
    if (!this.options.interactive || this.depth > 0) return Promise.resolve({ approved: false, note: 'nobody is here to approve' })
    const request = { id: randomUUID().slice(0, 8), action: req.action, title: scrubAll(req.title), detail: scrubAll(req.detail).slice(0, 20_000), at: new Date().toISOString() }
    this.session.pendingApprovals = [...(this.session.pendingApprovals ?? []), request]
    this.setState('waiting_user', `Approval needed: ${request.title}`)
    this.emit({ type: 'approval_request', request })
    return new Promise((resolve) => {
      this.approvals.set(request.id, (a) => {
        this.approvals.delete(request.id)
        this.session.pendingApprovals = (this.session.pendingApprovals ?? []).filter((r) => r.id !== request.id)
        if (this.session.state === 'waiting_user') this.setState('running')
        this.emit({ type: 'approval_resolved', id: request.id, approved: a.approved })
        resolve(a)
      })
    })
  }

  /** Answer a pending approval. Returns false when there is no such request (already answered). */
  resolveApproval(id: string, approved: boolean, note?: string): boolean {
    const answer = this.approvals.get(id)
    if (!answer) return false
    answer({ approved, ...(note ? { note } : {}) })
    return true
  }

  /** Follow-ups that arrived but were never shown to the model (the run ended first): handed back so they are not lost. */
  takeUninjected(): string[] {
    const left = this.followUpsToInject
    this.followUpsToInject = []
    const ids = new Set(left.map((f) => f.id))
    this.session.followUps = this.session.followUps.filter((f) => !ids.has(f.id))
    return left.map((f) => f.text)
  }

  stop(): void {
    this.stopped = true
    for (const id of [...this.approvals.keys()]) this.resolveApproval(id, false, 'the run was stopped')
    this.abort?.abort()
    for (const c of this.children) c.stop()
  }

  private async save(): Promise<void> {
    if (!this.ephemeral) await saveSession(this.session)
  }

  private savings(): NonNullable<Session['savings']> {
    this.session.savings ??= { compactedChars: 0, dedupedReads: 0, cheapCalls: 0, subagents: 0 }
    return this.session.savings
  }

  private setState(state: SessionState, reason?: string): void {
    this.session.state = state
    this.session.stateReason = reason
    this.emit({ type: 'state', state, reason })
  }

  private async prepareEnv(): Promise<void> {
    clearSecrets()
    const scope = `session:${this.session.id}`
    // A broken vault must not take the whole run down: continue without session
    // secrets, and say so.
    let secrets: Record<string, string> = {}
    try {
      secrets = await getSecretsForScope(scope)
    } catch (err) {
      this.emit({ type: 'error', message: scrubAll(`Secret vault unavailable — continuing without session secrets: ${(err as Error).message.split('\n')[0]}`) })
    }
    const env: Record<string, string> = { ...process.env } as Record<string, string>
    for (const [name, value] of Object.entries(secrets)) {
      env[name] = value
      registerSecret(value, name)
    }
    this.env = env
  }

  private toolContext(): ToolContext {
    return {
      cwd: this.session.config.cwd,
      mode: this.session.config.mode,
      sessionId: this.session.id,
      scope: `session:${this.session.id}`,
      env: this.env,
      allowPublish: this.session.config.allowPublish,
      ...(this.options.modePolicy?.() ? { modePolicy: this.options.modePolicy() } : {}),
      ...(this.options.admin && this.depth === 0 ? { admin: this.options.admin, approve: (r: { action: string; title: string; detail: string }) => this.requestApproval(r) } : {}),
      skills: this.skills,
      outputs: this.outputStore,
      smartRead: this.options.costSettings?.().smartRead ?? false,
      ...(this.depth === 0 ? { spawn: (tasks) => this.spawnSubagents(tasks) } : {}),
    }
  }

  private recordEvidence(record: EvidenceRecord): void {
    const scrubbed: EvidenceRecord = {
      ...record,
      output: record.output ? scrubAll(record.output).slice(0, 4000) : record.output,
      command: record.command ? scrubAll(record.command) : record.command,
    }
    this.session.evidence.push(scrubbed)
    if (this.session.evidence.length > 200) this.session.evidence.splice(0, this.session.evidence.length - 200)
    this.emit({ type: 'evidence', record: scrubbed })
  }

  /**
   * One turn elapsed with no real progress (no successful tool, no evidence).
   * Pauses the session once the consecutive-stall limit is reached — the single
   * place that decides this, shared by text-only turns and all-failing-tool
   * turns. Returns true when the engine must stop.
   */
  private async noteNoProgress(): Promise<boolean> {
    this.turnsWithoutProgress += 1
    if (this.turnsWithoutProgress < STALL_LIMIT) return false
    const reason =
      this.session.config.kind === 'goal'
        ? 'No progress in several cycles. Decide: keep going, adjust the goal, or stop.'
        : 'The agent has produced no actions or tool calls across several turns. Paused for your input.'
    this.setState('waiting_user', reason)
    this.emit({ type: 'waiting', reason: this.session.stateReason ?? '' })
    await this.save()
    return true
  }

  private toModelMessages(model: string): ModelMessage[] {
    const msgs = this.session.transcript
    // Enforce the REAL token budget computed by context.ts (window minus reserved
    // output minus safety margin) — not a fixed char threshold. A stress session
    // reached 106k input tokens against a 64k window because this path ignored
    // requestBudgetTokens entirely.
    // Session config has no per-session context override — the global default
    // is the single source of truth for output reservation.
    const budget = contextStatus(
      this.session,
      this.contextSettings?.() ?? { maxOutputTokens: DEFAULT_CONFIG.context.maxOutputTokens },
    ).requestBudgetTokens

    // Walk newest → oldest, keeping whole turns while they fit. Oldest tool
    // output is dropped first (it is the least reusable); the most recent
    // messages always survive so the model keeps its working state.
    const kept: ModelMessage[] = []
    const summary = this.session.summary
    let used = summary ? estimateTokens(summaryMessage(summary.text)) : 0
    let firstKept = false
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!
      // Folded into the summary: the model no longer carries it (the history still does).
      if (m.summarized) continue
      const sees = m.role === 'user' ? resolveImages(this.session.id, m.content, this.vision?.(model) ?? false) : null
      const msg: ModelMessage = {
        role: m.role === 'system' ? 'user' : m.role,
        content: sees ? sees.content : m.content,
        ...(sees?.images.length ? { images: sees.images } : {}),
        ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
        ...(m.reasoning?.length ? { reasoning: m.reasoning } : {}),
      }
      // A tool result is allowed to be replaced with a marker (cheaper), never
      // silently dropped — dropping it would orphan its assistant tool_call.
      // Likewise an assistant message carrying toolCalls must never be dropped:
      // its tool results would then be orphaned. Only plain text is droppable.
      const cost = estimateTokens(msg.content) + (msg.images?.length ?? 0) * IMAGE_TOKENS
      if (used + cost > budget && kept.length > 0) {
        if (m.role === 'tool') {
          kept.push({ ...msg, content: '[earlier tool output trimmed to save context]' })
        } else if (!msg.toolCalls?.length) {
          continue
        } else {
          kept.push(msg)
          used += cost
        }
        continue
      }
      used += cost
      kept.push(msg)
      if (i === 0) firstKept = true
    }
    const out = kept.reverse()
    if (summary) out.splice(firstKept ? 1 : 0, 0, { role: 'user', content: summaryMessage(summary.text) })
    // The volatile situation (turn counter, recent evidence) rides at the END so
    // the system prompt and the conversation before it stay cache-identical.
    if (isWorkIntent(this.intent) && this.depth === 0) out.push({ role: 'user', content: buildStateNote(this.session) })
    return out
  }

  /**
   * Cost control: every turn re-sends the whole conversation, and old tool
   * output (file dumps, test logs) is most of it. Once the context grows past a
   * soft limit, shrink everything but the recent messages in ONE batch — the
   * changed prefix is then stable again, so provider caching keeps working. The
   * full output stays in the audit log; only the model's copy is shortened.
   */
  private compactIfNeeded(): void {
    const msgs = this.session.transcript
    const budget = contextStatus(
      this.session,
      this.contextSettings?.() ?? { maxOutputTokens: DEFAULT_CONFIG.context.maxOutputTokens },
    ).requestBudgetTokens
    // Eco mode (opt-in, near the user's limit) compacts earlier.
    const soft = Math.floor(Math.min(Math.max(Math.floor(budget * 0.25), 8_000), 30_000) * (this.ecoActive ? 0.6 : 1))
    let total = 0
    for (const m of msgs) if (!m.summarized) total += estimateTokens(m.content)
    if (total < soft) return
    const keepFrom = Math.max(0, msgs.length - KEEP_RECENT_MESSAGES)
    let saved = 0
    for (let i = 0; i < keepFrom; i++) {
      const m = msgs[i]!
      if (m.role !== 'tool' || m.compacted || m.summarized || m.content.length <= COMPACT_THRESHOLD_CHARS) continue
      const next = shrinkForCompaction(m.content, m.content.length)
      if (next.length >= m.content.length) continue
      saved += m.content.length - next.length
      m.fullLength = m.fullLength ?? m.content.length
      m.content = next
      m.compacted = true
    }
    if (saved > 0) this.savings().compactedChars += saved
  }

  private addMessage(message: Omit<TranscriptMessage, 'at'>): void {
    this.session.transcript.push({ ...message, at: new Date().toISOString() })
  }

  private injectFollowUps(): void {
    if (this.followUpsToInject.length === 0) return
    const turn = this.session.usage.turns + 1
    // Conversation turns: the message is just the next thing the user said.
    if (!isWorkIntent(this.intent)) {
      for (const f of this.followUpsToInject) {
        f.appliedAtTurn = turn
        this.addMessage({ role: 'user', content: f.text })
        this.emit({ type: 'followup_applied', id: f.id, turn })
      }
      this.followUpsToInject = []
      return
    }
    for (const f of this.followUpsToInject) {
      f.appliedAtTurn = turn
      // A follow-up is not just chat: it becomes an active requirement that the
      // completion must account for, so scope drift cannot hide behind the
      // original objective.
      this.session.activeRequirements = this.session.activeRequirements ?? []
      this.session.activeRequirements.push(`[follow-up ${f.id.slice(0, 4)}] ${f.text}`)
      this.addMessage({
        role: 'user',
        content:
          `[FOLLOW-UP INSTRUCTION — applies from now on; it is now an ACTIVE REQUIREMENT ` +
          `numbered ${this.session.activeRequirements.length}]\n${f.text}\n\n` +
          `Re-evaluate the current plan. State in one line what changes, then continue. ` +
          `When you later claim completion you must list this requirement's number in verifiedRequirements.`,
      })
      this.emit({ type: 'followup_applied', id: f.id, turn })
    }
    this.followUpsToInject = []
  }

  /** Runs until the session reaches a terminal or waiting state. */
  async run(): Promise<Session> {
    await this.prepareEnv()
    this.session.pendingApprovals = undefined // a request from a run that died can no longer be answered
    try {
      this.skills = (await this.loadSkills?.()) ?? []
    } catch {
      this.skills = []
    }
    this.routeIntent()
    await this.sessionStarted()

    for (;;) {
      if (this.isTerminal()) break
      if (this.stopped) {
        this.setState('paused', 'Paused by you. State saved; send a message to resume.')
        await this.save()
        break
      }

      // Budgets bound WORK. A long conversation must not "exhaust" a session.
      if (isWorkIntent(this.intent)) this.warnBudget()

      const budgetReason = isWorkIntent(this.intent) ? this.checkBudget() : null
      if (budgetReason) {
        this.setState('paused', budgetReason)
        this.emit({ type: 'budget_exhausted', reason: budgetReason })
        // Exhaustion is never silent: emit the honest report of what is and
        // is not verified, so the user sees exactly where the work stopped.
        this.emitSessionSummary(
          `Budget exhausted — the session is PAUSED, not complete. ${budgetReason} ` +
            `Below is exactly what was verified and what remains.`,
        )
        await this.save()
        break
      }

      this.injectFollowUps()
      this.checkLimits()
      await this.maybeSummarise()
      this.compactIfNeeded()
      const outcome = await this.runTurn()
      this.session.usage.turns += 1
      this.session.usage.elapsedMs = Date.now() - new Date(this.session.usage.startedAt).getTime()
      await this.save()

      if (outcome === 'stop') break
    }

    return this.session
  }

  /**
   * Decide what this run is about, from the newest user words.
   *
   *   - A pinned session (auto off) is always its kind.
   *   - Unfinished work stays work: replies to ask_user, "continue", extra
   *     instructions are follow-ups, not new conversations.
   *   - Otherwise the message is classified; a new task/goal after a chat or a
   *     completed task becomes the session's new objective.
   */
  private routeIntent(): void {
    const s = this.session
    const pending = this.followUpsToInject.map((f) => f.text)
    const fresh = s.transcript.length === 0
    if (this.forceIntent) {
      if (fresh) this.addMessage({ role: 'user', content: s.config.objective })
      this.setIntent(this.forceIntent, 'sub-agent')
      return
    }
    const text = pending.length ? pending.join('\n') : fresh ? s.config.objective : ''
    const prev = s.intent

    let next: SessionIntent
    let reason: string
    if (!s.config.auto) {
      next = s.config.kind
      reason = `pinned to ${s.config.kind.toUpperCase()}`
    } else if (!text) {
      next = prev ?? s.config.kind
      reason = 'resuming'
    } else if (prev && isWorkIntent(prev) && !['completed', 'ready', 'idle'].includes(s.state)) {
      next = prev
      reason = 'continuing the unfinished work'
    } else {
      const guess = classifyIntent(text)
      next = guess.intent
      reason = guess.reason
    }

    const startsNewWork = isWorkIntent(next) && (!prev || !isWorkIntent(prev) || s.state === 'completed' || s.state === 'ready')
    if (startsNewWork) this.freshObjective = true
    if (startsNewWork && s.config.auto) {
      if (!fresh && pending.length) {
        s.config.objective = pending.join('\n')
      }
      s.activeRequirements = [...s.config.acceptance]
      if (!s.activeRequirements.length) s.activeRequirements.push(`The stated objective is achieved and verified: ${s.config.objective}`)
      s.completionClaim = undefined
      this.failedClaims = 0
      this.applyKind(next as SessionKind)
    }
    if (fresh) this.addMessage({ role: 'user', content: s.config.objective })
    if (startsNewWork && pending.length && !fresh) {
      // The new objective IS these messages: deliver them as the request, not as follow-up requirements.
      const turn = s.usage.turns + 1
      for (const f of this.followUpsToInject) {
        f.appliedAtTurn = turn
        this.addMessage({ role: 'user', content: f.text })
        this.emit({ type: 'followup_applied', id: f.id, turn })
      }
      this.followUpsToInject = []
    }
    this.setIntent(next, reason)
  }

  private setIntent(intent: SessionIntent, reason: string): void {
    this.intent = intent
    this.session.intent = intent
    this.emit({ type: 'intent', intent, reason })
  }

  private applyKind(kind: SessionKind): void {
    if (this.session.config.kind === kind) return
    this.session.config.kind = kind
    const budget = this.budgetFor?.(kind) ?? (kind === 'task' ? DEFAULT_CONFIG.budgets.task : DEFAULT_CONFIG.budgets.goal)
    this.session.config.budget = { ...budget }
  }

  /** The model called `escalate`: the conversation is now real work. */
  private escalate(to: 'task' | 'goal', objective: string): void {
    const s = this.session
    s.config.objective = objective
    s.activeRequirements = [`The stated objective is achieved and verified: ${objective}`]
    s.completionClaim = undefined
    this.failedClaims = 0
    this.turnsWithoutProgress = 0
    this.applyKind(to)
    this.freshObjective = true
    this.setIntent(to, 'the agent recognised a request for work')
  }

  /**
   * P2 budget guard: at 70% review requirements, at 80% stop non-essential
   * work, at 90% force a checkpoint report. Each warning fires once.
   */
  private warnBudget(): void {
    const b = this.session.config.budget
    const elapsed = Date.now() - new Date(this.session.usage.startedAt).getTime()
    const ratio = Math.max(
      this.session.usage.turns / b.maxTurns,
      elapsed / b.maxDurationMs,
      this.session.usage.modelCalls / b.maxModelCalls,
    )
    const percent = Math.floor(ratio * 100)
    let message: string | null = null
    if (percent >= 90 && this.lastBudgetWarning < 90) {
      message =
        `[BUDGET — ${percent}% consumed] FINAL CHECKPOINT. Stop all non-essential work now. ` +
        `Run your verification commands, then either call complete with verifiedRequirements covering every ` +
        `active requirement, or use ask_user to report what is unfinished. The budget will run out very soon.`
    } else if (percent >= 80 && this.lastBudgetWarning < 80) {
      message =
        `[BUDGET — ${percent}% consumed] No more improvements or polish. Only critical fixes and ` +
        `verification remain. Work toward a final honest report.`
    } else if (percent >= 70 && this.lastBudgetWarning < 70) {
      const requirements = (this.session.activeRequirements ?? this.session.config.acceptance)
        .map((r, i) => `${i + 1}. ${r.slice(0, 160)}`)
        .join('\n')
      message =
        `[BUDGET — ${percent}% consumed] Review the active requirements now and prioritize what is still ` +
        `unverified:\n${requirements}\nPlan the remaining turns around proving or finishing these — nothing else.`
    }
    if (message === null) return
    this.lastBudgetWarning = percent
    this.addMessage({ role: 'user', content: message })
    this.emit({ type: 'budget_warning', percent, message })
  }

  private isTerminal(): boolean {
    return ['completed', 'failed', 'stopped'].includes(this.session.state)
  }

  private checkBudget(): string | null {
    const b = this.session.config.budget
    const elapsed = Date.now() - new Date(this.session.usage.startedAt).getTime()
    if (this.session.usage.turns >= b.maxTurns) return `Budget exhausted: reached ${b.maxTurns} turns.`
    if (elapsed >= b.maxDurationMs) return `Budget exhausted: reached ${Math.round(b.maxDurationMs / 60_000)} minutes.`
    if (this.session.usage.modelCalls >= b.maxModelCalls) return `Budget exhausted: reached ${b.maxModelCalls} model calls.`
    return null
  }

  private async sessionStarted(): Promise<void> {
    if (this.session.state === 'interrupted') {
      // Do not assume the interrupted turn completed — tell the model explicitly.
      this.addMessage({
        role: 'user',
        content:
          '[SYSTEM NOTE] The previous run was interrupted mid-turn. The in-flight work may be incomplete. ' +
          'Inspect the current state of the working directory (git status, changed files) and continue from there.',
      })
    }
    this.session.usage.startedAt = new Date().toISOString()
    this.session.lastProgressTurn = this.session.usage.turns
    this.setState('running')
    await this.save()
  }

  private async runTurn(): Promise<'continue' | 'stop'> {
    this.emit({ type: 'turn', turn: this.session.usage.turns + 1 })
    const ctx = this.toolContext()
    const hasSkills = this.skills.length > 0
    const extra = this.extraTools?.() ?? []
    const policy = this.options.modePolicy?.()
    const toolSet = { hasSkills, extra, canDelegate: this.depth === 0, canManage: !!this.options.admin && this.depth === 0, ...(policy ? { policy } : {}) }
    const allowed = new Set(toolsFor(this.intent, this.session.config.mode, toolSet).map((t) => t.name))

    // Cost routing (core/router.ts): the model for THIS turn, with a visible reason.
    const sessionModel = this.model ?? this.session.config.model ?? ''
    const decision = this.routeTurn(sessionModel)
    const model = decision.model
    const provider = this.providerForDecision(decision)
    if (decision.tier === 'cheap' && model !== sessionModel) this.savings().cheapCalls += 1
    // Thinking is for work: conversation stays fast and cheap. Eco mode keeps it for planning and recovery only.
    // Signed reasoning blocks belong to the model that wrote them: after a model switch they are not replayed.
    const wantThinking = isWorkIntent(this.intent) && !(this.ecoActive && (decision.phase === 'edit' || decision.phase === 'search'))
    const thinking = wantThinking && (!this.lastReasoningModel || this.lastReasoningModel === model) ? this.thinkingLevel?.(model) : undefined
    this.lastModelUsed = model
    this.currentProvider = provider
    this.lastRoute = { tier: decision.tier, phase: decision.phase }
    this.freshObjective = false
    this.verificationFailedNext = false

    this.abort = new AbortController()
    if (this.stopped) this.abort.abort()
    let assistantText = ''
    let result: { content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> } | null = null
    let usage: NormalizedUsage | undefined

    // Persistent notes: the owner's own turns only (work and questions; chat and sub-agents stay lean).
    const memoryText = this.depth === 0 && this.intent !== 'chat' ? this.options.memoryBlock?.() ?? '' : ''
    const systemPrompt = buildSystemPrompt(this.session, {
      intent: this.intent,
      skills: skillIndex(this.skills),
      mcp: this.mcpSummary?.() || undefined,
      ...(memoryText ? { memory: memoryText } : {}),
      ...(extra.some((t) => t.name === 'web_search' || t.name === 'web_fetch') && this.intent !== 'chat' ? { web: true } : {}),
      subagent: this.depth > 0,
      ...(this.options.admin?.system && this.depth === 0 ? { selfManage: true } : {}),
      ...(policy ? { modeNote: describePolicy(policy) } : {}),
    })
    const toolDefs = toolDefinitions(this.session.config.mode, this.intent, toolSet)
    this.lastOverheadChars = systemPrompt.length + JSON.stringify(toolDefs).length

    try {
      for await (const event of provider.chat({
        system: systemPrompt,
        messages: this.toModelMessages(model),
        tools: toolDefs,
        model,
        cacheKey: this.session.id,
        ...(thinking !== undefined ? { thinking } : {}),
        signal: this.abort.signal,
      })) {
        if (event.type === 'text') {
          assistantText += event.delta
          this.emit({ type: 'text', delta: scrubAll(event.delta) })
        } else if (event.type === 'thinking') {
          // Reasoning stream: display-only, scrubbed like any model output,
          // and never persisted to the audit log (see this.emit).
          this.emit({ type: 'thinking', text: scrubAll(event.text) })
        } else if (event.type === 'error') {
          // An intentional abort (Esc / pause) is not a model failure.
          if (this.abort.signal.aborted) {
            // The request was in flight: tokens may have been consumed but
            // none were reported — record the attempt with UNKNOWN usage.
            this.recordModelCall(undefined, 'Aborted mid-request by user; usage unreported.')
            this.setState('paused', 'Paused by you. State saved; send a message to resume.')
            await this.save()
            return 'stop'
          }
          this.recordModelCall(undefined, `Provider error: ${event.message}`)
          this.addMessage({ role: 'assistant', content: assistantText || '(no output)' })
          this.setState('paused', `Model error: ${event.message}`)
          this.emit({ type: 'error', message: event.message })
          await this.save()
          return 'stop'
        } else if (event.type === 'done') {
          result = event.result
          usage = event.usage
        }
      }
    } catch (err) {
      if (this.abort.signal.aborted) {
        this.recordModelCall(undefined, 'Aborted mid-request by user; usage unreported.')
        this.setState('paused', 'Paused by you. State saved; send a message to resume.')
        await this.save()
        return 'stop'
      }
      const message = (err as Error).message
      this.recordModelCall(undefined, `Request failed: ${message}`)
      this.setState('paused', `Run interrupted: ${message}`)
      await this.save()
      return 'stop'
    }

    this.session.usage.modelCalls += 1
    // Every completed call is one ledger entry — successes and failures alike,
    // so retries are counted exactly once each and never silently dropped.
    this.recordModelCall(usage, undefined, { tier: decision.tier, phase: decision.phase })
    const turn = result ?? { content: assistantText, toolCalls: [] }
    const reasoning = (result as { reasoning?: unknown[] } | null)?.reasoning
    this.lastReasoningModel = reasoning?.length ? model : undefined
    this.addMessage({
      role: 'assistant',
      content: turn.content,
      ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
      ...(turn.toolCalls.length && reasoning?.length ? { reasoning } : {}),
    })

    if (turn.toolCalls.length === 0) {
      // Conversation: a text reply IS the answer — the turn is over, wait for
      // the user. (Looping here is what made the agent repeat itself.)
      if (!isWorkIntent(this.intent)) {
        this.turnsWithoutProgress = 0
        this.setState('ready')
        await this.save()
        return 'stop'
      }
      // Work: a text-only turn means the model is talking instead of acting.
      // Tell it exactly what the engine expects — never silently re-ask.
      if (await this.noteNoProgress()) return 'stop'
      this.addMessage({
        role: 'user',
        content:
          this.intent === 'goal'
            ? '[ENGINE] No tool call this cycle. If nothing needs action right now, call ask_user to report the current state and wait; otherwise continue the goal with a tool call.'
            : '[ENGINE] Your reply had no tool call. If the work is finished and verified, call `complete`. If you need a decision or information from the user, call `ask_user`. Otherwise continue the work with the next tool call.',
      })
      return 'continue'
    }

    let pauseReason: string | null = null
    let completionClaim: { summary: string; verificationPlan: string; verifiedRequirements?: string[] } | null = null
    let escalation: { to: 'task' | 'goal'; objective: string } | null = null
    // Real progress is a SUCCESSFUL tool or new evidence — not merely a
    // failing call that appends an error line to the transcript. Without this
    // distinction a loop of failing calls looks like forward motion and never
    // trips the stall detector (observed: 247 turns, zero evidence).
    let anyToolSucceeded = false
    let loopStop = ''
    // Images produced by tools this turn (browser screenshots): shown to the model once ALL results are in.
    const shots: string[] = []
    const turnTools: string[] = []
    let turnAllOk = true
    // R4: read-only calls of one turn run side by side. Only calls that passed
    // the SAME checks as below (allowed set, valid JSON, authorize) are started
    // early; results are still appended in call order.
    const prefetched = this.options.costSettings ? await this.prefetchReads(turn.toolCalls, extra, allowed, ctx) : new Map<string, Promise<ToolResult>>()

    for (const rawCall of turn.toolCalls) {
      const call = {
        ...rawCall,
        id: rawCall.id || `call_${randomUUID().slice(0, 8)}`,
      }
      this.session.usage.toolCalls += 1
      const tool = findTool(call.name, extra)
      if (!tool) {
        this.appendToolResult(call.id, call.name, false, `Unknown tool: ${call.name}`)
        continue
      }
      // Work turns leave mode checks to authorize() (it explains plan mode);
      // conversation turns only ever get their small tool set.
      if (!allowed.has(call.name) && (!isWorkIntent(this.intent) || call.name === 'escalate' || call.name === 'skill')) {
        const msg =
          this.intent === 'chat' || this.intent === 'question'
            ? `"${call.name}" is not available while answering. If the user wants work done, call escalate first.`
            : `"${call.name}" is not available in this mode.`
        this.appendToolResult(call.id, call.name, false, msg)
        this.emit({ type: 'tool_end', id: call.id, name: call.name, ok: false, output: msg })
        continue
      }

      this.emit({ type: 'tool_start', name: call.name, args: scrubAll(call.arguments), id: call.id })

      let parsed: unknown
      const rawArgs = call.arguments || '{}'
      try {
        parsed = JSON.parse(rawArgs)
      } catch {
        const repaired = repairTruncatedJson(rawArgs)
        if (repaired === null) {
          const streak = (this.toolFailureStreak.get(call.name) ?? 0) + 1
          this.toolFailureStreak.set(call.name, streak)
          const repeatNote =
            streak >= 2
              ? ` This is the ${streak}th unreadable argument set for this tool — stop and rethink the call entirely.`
              : ''
          const msg =
            `Invalid JSON arguments (unrecoverable). The call to "${call.name}" was not executed. ` +
            `Re-issue the call with ONE complete, valid JSON object as arguments — every string fully closed, ` +
            `no trailing commas, no truncation.${repeatNote} Raw arguments received: ${rawArgs.slice(0, 200)}`
          this.appendToolResult(call.id, call.name, false, msg)
          this.emit({ type: 'tool_end', id: call.id, name: call.name, ok: false, output: msg })
          continue
        }
        parsed = repaired
      }

      const decision = authorize(tool, parsed, ctx)
      if (!decision.allowed) {
        this.appendToolResult(call.id, call.name, false, `Denied: ${decision.reason}`)
        this.emit({ type: 'tool_end', id: call.id, name: call.name, ok: false, output: `Denied: ${decision.reason}` })
        continue
      }

      let output = ''
      let ok = false
      const dedupe = await this.tryDedupeRead(call.name, parsed, call.id)
      if (dedupe) {
        this.savings().dedupedReads += 1
        ok = true
        output = dedupe
      } else {
        try {
          const result2 = await (prefetched.get(call.id) ?? (tool.execute as (a: unknown, c: ToolContext) => Promise<{
            ok: boolean
            output: string
            pauseForUser?: string
            completeClaim?: { summary: string; verificationPlan: string; verifiedRequirements?: string[] }
            escalate?: { to: 'task' | 'goal'; objective: string }
            images?: string[]
          }>)(parsed, ctx))
          ok = result2.ok
          output = scrubAll(result2.output)
          if (result2.images?.length) shots.push(...result2.images)
          if (result2.pauseForUser) pauseReason = result2.pauseForUser
          if (result2.completeClaim) completionClaim = result2.completeClaim
          if (result2.escalate) escalation = result2.escalate
        } catch (err) {
          ok = false
          output = `Tool crashed: ${(err as Error).message}`
        }
      }
      if (ok && !dedupe && call.name === 'read_file' && !output.includes(OUTLINE_MARK)) await this.rememberRead(parsed, call.id)
      if (ok && !tool.readonly && !NON_MUTATING.has(call.name)) {
        this.mutationEpoch += 1
        invalidateRepoMap(this.session.config.cwd)
      }
      turnTools.push(call.name)
      if (!ok) turnAllOk = false

      // Loop detection: identical tool call repeated consecutively
      const callSignature = `${call.name}:${call.arguments}`
      if (callSignature === this.lastToolSignature) {
        this.identicalToolStreak += 1
      } else {
        this.lastToolSignature = callSignature
        this.identicalToolStreak = 1
      }
      if (this.options.costSettings && this.identicalToolStreak >= LOOP_HARD_STOP && isWorkIntent(this.intent)) loopStop = call.name
      if (this.identicalToolStreak >= 3) {
        output += `\n[engine] Loop detected: "${call.name}" was called with identical arguments ${this.identicalToolStreak} times in a row. Stop repeating this action. Inspect the result or change strategy.`
      }

      // P0: consecutive-failure limit. Two failures of the same tool in a row
      // means the approach itself is wrong — tell the model to change it
      // instead of burning turns on near-identical retries.
      if (ok) {
        this.toolFailureStreak.delete(call.name)
      } else {
        const streak = (this.toolFailureStreak.get(call.name) ?? 0) + 1
        this.toolFailureStreak.set(call.name, streak)
        if (streak >= 2) {
          output +=
            `\n[engine] This tool has failed ${streak} times in a row. Do NOT retry the same call. ` +
            `Change strategy: inspect the current state (read_file/list_dir/shell dir), ` +
            `verify your paths and quoting, or use a different tool. If the task is blocked, use ask_user.`
        }
      }

      const shaped = this.shapeOutput(call.id, call.name, output)
      output = shaped.text
      this.appendToolResult(call.id, call.name, ok, output, shaped.fullLength)
      this.emit({ type: 'tool_end', id: call.id, name: call.name, ok, output })
      if (ok) anyToolSucceeded = true
    }

    this.lastTurnTools = { tools: turnTools, allOk: turnAllOk }

    // Tool-made images ride in one hidden engine message after the tool results (providers need the results first).
    if (shots.length) this.addMessage({ role: 'user', content: ['[ENGINE] Image(s) from your last tool call:', ...shots.slice(0, 4)].join(String.fromCharCode(10)) })

    // Only genuine progress resets the stall counter: a successful tool or a
    // completed claim. A run of failing calls keeps counting toward the limit.
    if (escalation) {
      this.escalate(escalation.to, escalation.objective)
      await this.save()
      return 'continue'
    }

    if (loopStop) {
      // Every result is already in the transcript, so the conversation stays valid; the user decides what next.
      this.savings().loopStops = (this.savings().loopStops ?? 0) + 1
      const why = `The agent called "${loopStop}" with identical arguments ${this.identicalToolStreak} times in a row and is not making progress. Paused so no more of your limit is spent on the loop — tell it what to do differently, or stop.`
      this.setState('waiting_user', why)
      this.emit({ type: 'waiting', reason: why })
      await this.save()
      return 'stop'
    }

    if (anyToolSucceeded || completionClaim) {
      this.turnsWithoutProgress = 0
      this.session.lastProgressTurn = this.session.usage.turns
    } else if (await this.noteNoProgress()) {
      return 'stop'
    }

    if (completionClaim) {
      const verified = await this.verify(completionClaim)
      this.session.completionClaim = { ...completionClaim, at: new Date().toISOString() }
      if (verified.ok) {
        this.setState('completed', completionClaim.summary)
        this.emit({ type: 'completed', summary: completionClaim.summary })
        this.emitSessionSummary(completionClaim.summary)
        await this.save()
        return 'stop'
      }
      this.failedClaims += 1
      this.verificationFailedNext = true
      this.emit({ type: 'verification', ok: false, detail: verified.detail })
      this.addMessage({
        role: 'user',
        content: `[SYSTEM — VERIFICATION FAILED]\nThe engine could not accept the completion claim. Fix these, then verify again and only then claim completion:\n${verified.detail.slice(0, 6000)}`,
      })
      if (this.failedClaims >= MAX_FAILED_CLAIMS) {
        this.setState(
          'failed',
          `Completion claimed ${this.failedClaims} times but verification kept failing: ${verified.detail.slice(0, 500)}`,
        )
        await this.save()
        return 'stop'
      }
      return 'continue'
    }

    if (pauseReason) {
      this.setState('waiting_user', pauseReason)
      this.emit({ type: 'waiting', reason: pauseReason })
      await this.save()
      return 'stop'
    }

    return 'continue'
  }

  /** A full read of a file we already hold, unchanged on disk: answer from context. */
  private async tryDedupeRead(name: string, args: unknown, _callId: string): Promise<string | null> {
    if (name !== 'read_file') return null
    const a = args as { path?: string; offset?: number; limit?: number }
    if (!a?.path || a.offset || a.limit) return null
    const abs = resolvePath(this.session.config.cwd, a.path)
    const prev = this.readCache.get(abs)
    if (!prev) return null
    try {
      const st = await stat(abs)
      if (st.mtimeMs !== prev.mtimeMs) return null
    } catch {
      return null
    }
    // Only if that earlier output is still in the conversation in full.
    const holder = this.session.transcript.find((m) => m.role === 'tool' && m.toolCallId === prev.callId)
    if (!holder || holder.compacted) return null
    return `[unchanged since you read it earlier — the full content is already in this conversation (tool call ${prev.callId.slice(0, 8)}). Use it, or read a slice with offset/limit.]`
  }

  private async rememberRead(args: unknown, callId: string): Promise<void> {
    const a = args as { path?: string; offset?: number; limit?: number }
    if (!a?.path || a.offset || a.limit) return
    const abs = resolvePath(this.session.config.cwd, a.path)
    try {
      this.readCache.set(abs, { mtimeMs: (await stat(abs)).mtimeMs, callId })
    } catch {
      /* not a regular file: nothing to remember */
    }
  }

  /**
   * Run a swarm of sub-agents (see swarm.ts): named roles, a shared task list
   * with dependencies, a cap on concurrency and on model calls / cost, and one
   * merged report. Each agent is an ephemeral session with the parent's mode
   * AND custom-mode policy, the cheaper routed model, and no right to delegate.
   * Their model calls are merged into the parent's ledger so cost stays true.
   */
  private async spawnSubagents(inputs: SwarmTaskInput[]): Promise<string> {
    const limits = clampLimits(this.options.swarm?.())
    const parentMode = this.session.config.mode
    const planned = planSwarm(inputs, limits, { readOnly: parentMode === 'plan' })
    if (!planned.ok) return `Swarm plan rejected: ${planned.error}`
    const swarm = ++this.swarmCount
    this.swarmCancelled = false
    this.cancelledTasks.clear()
    type Extra = { detail?: string; steps?: number; calls?: number; costUsd?: number | null; report?: string; cancelled?: boolean }
    const view = (t: SwarmTask, status: SwarmStatus, extra: Extra = {}): void =>
      this.emit({ type: 'subagent', id: t.id, title: t.title, status, swarm, kind: t.kind, ...(t.role ? { role: t.role } : {}), ...(t.dependsOn.length ? { dependsOn: t.dependsOn } : {}), ...extra })
    const out = await runSwarm({
      tasks: planned.tasks,
      limits,
      shouldStop: () => (this.swarmCancelled ? 'cancelled by the user' : null),
      onStatus: (t, status, detail, o) =>
        view(t, status, {
          ...(detail ? { detail } : {}),
          ...(o ? { calls: o.modelCalls, costUsd: o.costUsd, report: scrubAll(o.report).slice(0, 2_000) } : {}),
          ...(this.cancelledTasks.has(t.id) ? { cancelled: true } : {}),
        }),
      run: async (task, ctx) => {
        const child = createSession(
          CreateSessionInput.parse({ kind: 'task', mode: parentMode, objective: task.prompt, cwd: this.session.config.cwd, auto: false }),
          DEFAULT_CONFIG,
        )
        if (this.session.config.customMode) child.config.customMode = this.session.config.customMode
        child.config.disabledSkills = this.session.config.disabledSkills
        child.config.disabledMcp = this.session.config.disabledMcp
        // The sub-agent sees the shared plan and what the tasks it waits for found.
        const deps = Object.entries(ctx.deps).map(([id, r]) => `## Report of ${id}\n${r.slice(0, 3000)}`).join('\n\n')
        child.config.objective = [task.roleNote, `Team plan (you are ${task.id}):\n${ctx.peers}`, deps, `Your task: ${task.prompt}`].filter(Boolean).join('\n\n')
        child.config.budget = { maxTurns: task.kind === 'work' ? 25 : 12, maxDurationMs: 10 * 60_000, maxModelCalls: Math.min(60, ctx.callsLeft) }
        // The child routes itself (depth 1: research stays cheap, editing sub-agents follow the floor).
        const childModel = this.model || this.session.config.model
        child.config.model = childModel
        let lastTool = ''
        let steps = 0
        const engine = new Engine({
          ...this.options,
          session: child,
          model: childModel,
          ephemeral: true,
          depth: this.depth + 1,
          forceIntent: task.kind === 'explore' ? 'question' : 'task',
          onEvent: (e) => {
            if (e.type === 'tool_start') {
              steps++
              lastTool = e.name
              view(task, 'running', { detail: e.name, steps })
            }
          },
        })
        this.children.push(engine)
        this.childByTask.set(task.id, engine)
        try {
          await engine.run()
        } finally {
          this.children = this.children.filter((c) => c !== engine)
          this.childByTask.delete(task.id)
        }
        // Cost: the child's calls belong to this session's bill.
        this.session.modelCalls ??= []
        for (const rec of child.modelCalls ?? []) this.session.modelCalls.push({ ...rec, turn: this.session.usage.turns + 1 })
        this.applyUsageTotals(aggregateModelCalls(this.session.modelCalls))
        this.savings().subagents += 1
        const lastText = [...child.transcript].reverse().find((m) => m.role === 'assistant' && m.content.trim())?.content.trim()
        const cancelled = this.cancelledTasks.has(task.id) || this.swarmCancelled
        // A child that ended paused / stopped / interrupted (a provider error, its budget) did NOT finish its job, whatever text it left.
        const failed = cancelled || ['failed', 'paused', 'stopped', 'interrupted'].includes(child.state) || (child.state !== 'ready' && child.state !== 'completed' && !lastText)
        const own = aggregateModelCalls(child.modelCalls ?? [])
        const report = child.completionClaim?.summary ?? lastText ?? '(the sub-agent produced no report)'
        return {
          report: cancelled ? `CANCELLED by the user.${lastText ? ` What it had so far:\n${report}` : ''}` : failed ? `FAILED (${child.stateReason ?? child.state})\n${report}` : report,
          failed,
          modelCalls: child.usage.modelCalls,
          costUsd: own.costPartial || own.unpricedCalls > 0 ? null : own.costUsd,
        }
      },
    })
    const count = (s: string): number => out.results.filter((r) => r.status === s).length
    this.emit({ type: 'swarm_report', swarm, merged: scrubAll(out.merged).slice(0, 12_000), modelCalls: out.modelCalls, costUsd: out.costUsd, done: count('done'), failed: count('failed'), skipped: count('skipped') })
    return out.merged
  }

  /**
   * Cancel one running sub-agent (`id`) or the whole swarm (no id): running ones are stopped, waiting ones are
   * skipped, and whatever depends on a cancelled task is skipped by the swarm's normal rule. Returns false when
   * nothing was running.
   */
  cancelSubagents(id?: string): boolean {
    if (id) {
      const child = this.childByTask.get(id)
      if (!child) return false
      this.cancelledTasks.add(id)
      child.stop()
      return true
    }
    if (!this.childByTask.size && !this.children.length) return false
    this.swarmCancelled = true
    for (const [tid, child] of this.childByTask) {
      this.cancelledTasks.add(tid)
      child.stop()
    }
    return true
  }

  /* ---------- cost engine v2 (see docs/COST.md) ---------- */

  private routerSettings(): RouterSettings {
    return { ...(this.options.router?.() ?? DEFAULT_ROUTER), eco: this.ecoActive }
  }

  /** The model for one turn, with the reason the user can read. */
  private routeTurn(sessionModel: string): RouteDecision {
    const settings = this.routerSettings()
    const failureStreak = Math.max(0, ...this.toolFailureStreak.values())
    let d = decideRoute({
      settings,
      intent: this.intent,
      depth: this.depth,
      sessionModel,
      legacyCheap: this.routeModel?.('chat') || undefined,
      planMode: this.session.config.mode === 'plan',
      objective: this.session.config.objective,
      freshObjective: this.freshObjective,
      lastTurn: this.lastTurnTools,
      verificationFailed: this.verificationFailedNext,
      failureStreak,
      ...(this.previousTier ? { previousTier: this.previousTier } : {}),
      recentDesired: this.recentDesired,
      subagentKind: this.forceIntent === 'question' ? 'explore' : 'work',
      contextTokens: this.liveContextTokens(),
    })
    // A tier on a provider we cannot reach falls back to the session model, and says so.
    if (d.provider && !this.options.providerFor?.(d.provider)) {
      d = { ...d, model: sessionModel, provider: undefined, reason: `${d.reason} · provider "${d.provider}" is not available — using the session model` } as RouteDecision
    }
    this.previousTier = d.tier
    this.recentDesired = [...this.recentDesired, d.desired].slice(-4)
    const stats = (this.session.routing ??= { calls: { strong: 0, standard: 0, cheap: 0 }, escalations: 0 })
    stats.calls[d.tier] += 1
    if (d.escalated) stats.escalations += 1
    stats.last = { tier: d.tier, model: d.model, phase: d.phase, reason: d.reason }
    this.emit({ type: 'route', tier: d.tier, model: d.model, phase: d.phase, reason: d.reason })
    return d
  }

  /** Tokens the model would have to read fresh: what is not folded into a summary. */
  private liveContextTokens(): number {
    let n = this.session.summary ? estimateTokens(this.session.summary.text) : 0
    for (const m of this.session.transcript) if (!m.summarized) n += estimateTokens(m.content)
    return n
  }

  private providerForDecision(d: RouteDecision): Provider {
    return (d.provider ? this.options.providerFor?.(d.provider) : undefined) ?? this.provider
  }

  /** Soft warnings and the opt-in eco mode, from the shared usage meter. */
  private checkLimits(): void {
    const meter = this.options.meter
    const limits = this.options.limits?.()
    if (!meter || !limits || limits.unit === 'none' || this.depth > 0) {
      this.ecoActive = false
      return
    }
    const st = meter.status(limits)
    const wasEco = this.ecoActive
    this.ecoActive = limits.autoEco && st.percent !== null && st.percent >= limits.ecoAt
    const rank = st.level === 'critical' ? 3 : st.level === 'high' ? 2 : st.level === 'warn' ? 1 : 0
    if ((rank > this.lastLimitLevel || (this.ecoActive && !wasEco)) && st.percent !== null && rank > 0) {
      this.lastLimitLevel = Math.max(rank, this.lastLimitLevel)
      const tail = this.ecoActive
        ? ' Eco mode is on (you opted in): routine turns use a lighter tier, never below your quality floor.'
        : limits.autoEco
          ? ''
          : ' You can turn on auto-eco in Settings to stretch what is left.'
      this.emit({ type: 'usage_limit', percent: Math.round(st.percent), level: st.level === 'ok' || st.level === 'unknown' ? 'warn' : st.level, message: st.message + tail, eco: this.ecoActive })
    }
  }

  /**
   * Keep what a reader needs of a tool result, store the rest where the model
   * can ask for it, and point at an identical earlier result instead of
   * repeating it. Without cost settings (older callers) the v0.4.0 cut applies.
   */
  private shapeOutput(callId: string, name: string, output: string): { text: string; fullLength: number } {
    const fullLength = Math.min(output.length, MAX_TOOL_OUTPUT_CHARS)
    const cs = this.options.costSettings?.()
    if (!cs || cs.compress === false || name === 'read_file') {
      const text = output.length > MAX_TOOL_OUTPUT_CHARS ? output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n…[output truncated]' : output
      return { text, fullLength }
    }
    const cap = Math.floor(cs.toolOutputChars * (this.ecoActive ? 0.6 : 1))
    const c = compressToolOutput(output, cap, callId)
    let text = c.text
    if (c.compressed) {
      this.outputStore.put(callId, output)
      this.savings().compressedChars = (this.savings().compressedChars ?? 0) + c.omittedChars
    } else if (text.length >= 400 && name !== 'tool_output') {
      const key = `${name}:${contentHash(text)}`
      const prev = this.outputHashes.get(key)
      const alive = prev ? this.session.transcript.find((m) => m.toolCallId === prev && !m.compacted && !m.summarized) : undefined
      if (prev && alive) {
        text = `[identical to the output of tool call ${prev.slice(0, 8)} earlier in this conversation — nothing changed]`
        this.savings().dedupedOutputs = (this.savings().dedupedOutputs ?? 0) + 1
      } else this.outputHashes.set(key, callId)
    }
    return { text, fullLength }
  }

  /** R4: start the independent read-only calls of one turn together. Same checks as the sequential path. */
  private async prefetchReads(
    calls: Array<{ id: string; name: string; arguments: string }>,
    extra: Tool<never>[],
    allowed: Set<string>,
    ctx: ToolContext,
  ): Promise<Map<string, Promise<ToolResult>>> {
    const out = new Map<string, Promise<ToolResult>>()
    const todo: Array<{ id: string; tool: Tool<never>; args: unknown }> = []
    for (const c of calls) {
      if (!c.id || !PARALLEL_SAFE.has(c.name)) continue
      const tool = findTool(c.name, extra)
      if (!tool || !tool.readonly) continue
      if (!allowed.has(c.name) && !isWorkIntent(this.intent)) continue
      let args: unknown
      try {
        args = JSON.parse(c.arguments || '{}')
      } catch {
        continue
      }
      if (!authorize(tool, args, ctx).allowed) continue
      if (await this.tryDedupeRead(c.name, args, c.id)) continue
      todo.push({ id: c.id, tool, args })
    }
    if (todo.length < 2) return out
    for (const t of todo) {
      out.set(
        t.id,
        (t.tool.execute as (a: unknown, c: ToolContext) => Promise<ToolResult>)(t.args, ctx).catch((err: unknown) => ({ ok: false, output: `Tool crashed: ${(err as Error).message}` })),
      )
    }
    return out
  }

  /** R5: fold old turns into one cheap-model summary (only when a cheaper model exists). */
  private async maybeSummarise(): Promise<void> {
    const cs = this.options.costSettings?.()
    if (!cs?.summarize || this.depth > 0 || this.ephemeral) return
    const sessionModel = this.model ?? this.session.config.model ?? ''
    const d = decideRoute({
      settings: this.routerSettings(),
      intent: this.intent,
      depth: 0,
      sessionModel,
      legacyCheap: this.routeModel?.('chat') || undefined,
      planMode: false,
      objective: '',
      freshObjective: false,
      lastTurn: null,
      verificationFailed: false,
      failureStreak: 0,
      purpose: 'summary',
    })
    const provider = d.provider ? this.options.providerFor?.(d.provider) : this.provider
    if (!provider || (d.model === sessionModel && !d.provider)) return // no cheaper model: compaction does the job
    const budget = contextStatus(this.session, this.contextSettings?.() ?? { maxOutputTokens: DEFAULT_CONFIG.context.maxOutputTokens }).requestBudgetTokens
    const msgs = this.session.transcript
    const plan = planSummary(msgs, { keepRecent: 10, minTokens: Math.min(Math.max(12_000, Math.floor(budget * 0.15)), 30_000) })
    if (!plan) return
    const previous = this.session.summary?.text
    let text = ''
    let usage: NormalizedUsage | undefined
    this.abort = new AbortController()
    try {
      for await (const ev of provider.chat({
        system: SUMMARY_SYSTEM,
        messages: [{ role: 'user', content: renderForSummary(msgs, plan, previous) }],
        tools: [],
        model: d.model,
        maxTokens: 900,
        signal: this.abort.signal,
      })) {
        if (ev.type === 'text') text += ev.delta
        else if (ev.type === 'done') usage = ev.usage
        else if (ev.type === 'error') return // keep compaction as the fallback
      }
    } catch {
      return
    }
    this.session.usage.modelCalls += 1
    this.lastModelUsed = d.model
    this.currentProvider = provider
    this.recordModelCall(usage, 'summary of older turns', { tier: d.tier, phase: 'summarise', overhead: true })
    const summary = scrubAll(text).trim()
    if (!summary) return
    for (let i = plan.from; i < plan.to; i++) msgs[i]!.summarized = true
    this.session.summary = { text: summary.slice(0, 4_000), upTo: plan.to, at: new Date().toISOString(), foldedMessages: plan.to - plan.from, foldedTokens: plan.tokens }
    this.savings().summarizedTokens = (this.savings().summarizedTokens ?? 0) + Math.max(0, plan.tokens - estimateTokens(summary))
    this.emit({ type: 'route', tier: d.tier, model: d.model, phase: 'summarise', reason: d.reason })
  }

  private appendToolResult(callId: string, name: string, ok: boolean, output: string, fullLength?: number): void {
    this.addMessage({ role: 'tool', content: `[${ok ? 'OK' : 'FAIL'}] ${output}`, toolCallId: callId, toolName: name, ...(fullLength !== undefined ? { fullLength: fullLength + 5 } : {}) })
  }

  /**
   * Independent verification. The engine — not the model — gathers the evidence:
   * changed files, git state, and the configured verification command's exit code.
   */
  private async verify(claim: {
    summary: string
    verificationPlan: string
    verifiedRequirements?: string[]
  }): Promise<{ ok: boolean; detail: string }> {
    const ctx = this.toolContext()
    const details: string[] = []
    let ok = true

    // 1) Requirement coverage: every active requirement (original acceptance
    //    conditions + applied follow-ups) must be explicitly accounted for.
    const requirements = this.session.activeRequirements ?? this.session.config.acceptance
    if (!requirements.length) {
      // 0/0 is NOT success: an empty requirement list means the engine has
      // nothing to hold the claim against, so the claim must be rejected.
      ok = false
      details.push(
        'No active requirements are recorded, so this completion cannot be accepted. ' +
          'This is a recording problem, not a pass: report it via ask_user instead of claiming success.',
      )
    } else {
      const claimed = new Set((claim.verifiedRequirements ?? []).map((s) => s.trim()))
      const missing: string[] = []
      requirements.forEach((requirement, i) => {
        if (!claimed.has(String(i + 1))) missing.push(`${i + 1}. ${requirement.slice(0, 200)}`)
      })
      if (missing.length) {
        ok = false
        details.push(
          `The completion claim does not cover ${missing.length} active requirement(s):\n` +
            missing.map((m) => `  - ${m}`).join('\n') +
            `\nEither finish that work and re-claim with every requirement number in verifiedRequirements, ` +
            `or ask the user to drop the requirement.`,
        )
      }
    }

    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)

    try {
      const { stdout } = await run('git', ['status', '--porcelain'], { cwd: ctx.cwd, windowsHide: true })
      this.recordEvidence({
        at: new Date().toISOString(),
        kind: 'git_status',
        ok: true,
        output: stdout.trim() || 'clean tree',
      })
      if (!stdout.trim()) {
        details.push('Note: the git working tree is clean — either nothing changed here or changes were committed.')
      }
    } catch {
      this.recordEvidence({ at: new Date().toISOString(), kind: 'git_status', ok: false, output: 'not a git repository' })
      details.push('Note: the working directory is not a git repository, so file-change evidence is limited.')
    }

    const verifyCommand = this.session.config.verifyCommand
    if (verifyCommand) {
      // Nothing that can change files succeeded since the last run of this very command: its result still holds.
      const reuse = this.options.costSettings && this.lastVerify && this.lastVerify.epoch === this.mutationEpoch && this.lastVerify.command === verifyCommand
      const run2 = reuse ? this.lastVerify!.run : await runVerificationCommand(verifyCommand, ctx.cwd, this.env)
      if (reuse) this.savings().skippedVerifications = (this.savings().skippedVerifications ?? 0) + 1
      else this.lastVerify = { epoch: this.mutationEpoch, command: verifyCommand, run: { exitCode: run2.exitCode, output: run2.output } }
      this.recordEvidence({
        at: new Date().toISOString(),
        kind: 'command',
        command: verifyCommand,
        exitCode: run2.exitCode ?? -1,
        ok: run2.exitCode === 0,
        output: (reuse ? '(unchanged since the previous run — result reused, command not re-run) ' : '') + run2.output.slice(-6000),
      })
      if (run2.exitCode !== 0) {
        ok = false
        details.push(`Verification command \`${verifyCommand}\` exited with ${run2.exitCode}:\n${run2.output.slice(-3000)}`)
      }
    } else {
      this.recordEvidence({
        at: new Date().toISOString(),
        kind: 'note',
        ok: true,
        output: 'No verification command configured for this session; automated checks skipped.',
      })
      details.push('No verification command configured — acceptance relies on the model-reported checks below.')
    }

    const requirementTexts = this.session.activeRequirements?.length
      ? this.session.activeRequirements
      : this.session.config.acceptance
    const acceptanceNote = requirementTexts.length
      ? `Active requirements:\n${requirementTexts.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
      : ''
    const detail = [ok ? 'Automated checks passed.' : 'Automated checks FAILED.', ...details, acceptanceNote]
      .filter(Boolean)
      .join('\n\n')

    this.recordEvidence({
      at: new Date().toISOString(),
      kind: 'verification',
      ok,
      output: `Model's verification report: ${claim.verificationPlan.slice(0, 2000)}\n\nEngine detail:\n${detail.slice(0, 3000)}`,
    })

    if (ok) this.emit({ type: 'verification', ok: true, detail })
    return { ok, detail }
  }

  /**
   * Append one auditable per-call record to the ledger, re-derive the session
   * totals from the whole ledger, and emit the record for live display.
   *
   * `usage === undefined` means "the call happened but the endpoint reported
   * nothing" — every token field stays `null` (UNKNOWN), never 0. Cost is
   * computed only from the model registry's explicit pricing; otherwise it is
   * null with a note explaining why.
   */
  private recordModelCall(usage: NormalizedUsage | undefined, note?: string, meta?: { tier?: Tier; phase?: string; overhead?: boolean }): void {
    const normalized = usage ?? emptyUsage('provider')
    const model = this.lastModelUsed || (this.model ?? this.session.config.model ?? 'unknown')
    const cost = computeCost(normalized, null, model, this.currentProvider.id)
    const notes = [note, cost.reason].filter((n): n is string => Boolean(n))
    this.session.modelCalls ??= []
    // Defense in depth: cost notes can carry provider error text — scrub them
    // with the same pipeline as transcripts before anything is persisted.
    const record: ModelCallRecord = {
      at: new Date().toISOString(),
      model,
      providerId: this.currentProvider.id,
      turn: this.session.usage.turns + 1,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      cacheWriteTokens: normalized.cacheWriteTokens,
      usageSource: normalized.source,
      costUsd: cost.totalUsd,
      costPartial: cost.partial,
      costNote: notes.length ? scrubAll(notes.join(' — ')).slice(0, 500) : undefined,
      ...(meta?.tier ? { tier: meta.tier } : {}),
      ...(meta?.phase ? { phase: meta.phase } : {}),
    }
    // The savings baseline: what a plain loop would have sent for the same conversation.
    const baseIn = meta?.overhead ? 0 : naiveInputTokens(this.session, this.lastOverheadChars)
    record.baselineInputTokens = baseIn
    this.session.modelCalls.push(record)
    if (this.options.meter) {
      const baseModel = this.model ?? this.session.config.model ?? model
      const rec = recordFromCall(this.session.id, record, baseModel, baseIn)
      if (meta?.overhead) {
        rec.baseUsd = 0
        rec.ovh = true
      }
      this.options.meter.add(rec)
    }
    this.applyUsageTotals(aggregateModelCalls(this.session.modelCalls))
    this.emit({ type: 'model_usage', record })
  }

  /** Totals are always DERIVED from the ledger — never incremented in place. */
  private applyUsageTotals(totals: AggregatedUsage): void {
    const usage = this.session.usage
    usage.inputTokens = totals.inputTokens
    usage.outputTokens = totals.outputTokens
    usage.cachedInputTokens = totals.cachedInputTokens
    usage.cacheWriteTokens = totals.cacheWriteTokens
    usage.costUsd = totals.costUsd
    usage.costPartial = totals.costPartial
    usage.unpricedCalls = totals.unpricedCalls
  }

  /** Emit a final, self-contained report so the user always sees what ended and why. */
  private emitSessionSummary(summary: string): void {
    const claim = this.session.completionClaim
    const covered = new Set((claim?.verifiedRequirements ?? []).map((s) => s.trim()))
    const texts = this.session.activeRequirements?.length
      ? this.session.activeRequirements
      : this.session.config.acceptance.length
        ? this.session.config.acceptance
        : [`The stated objective is achieved and verified: ${this.session.config.objective}`]
    const requirements = texts.map((text, i) => ({
      id: String(i + 1),
      text,
      verified: claim ? covered.has(String(i + 1)) : false,
    }))
    this.emit({
      type: 'session_summary',
      summary,
      requirements,
      evidence: this.session.evidence,
      turns: this.session.usage.turns,
      toolCalls: this.session.usage.toolCalls,
      elapsedMs: Date.now() - new Date(this.session.usage.startedAt).getTime(),
      costUsd: this.session.usage.costUsd,
      costPartial: this.session.usage.costPartial || this.session.usage.unpricedCalls > 0,
    })
  }
}
