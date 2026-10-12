import { randomUUID } from 'node:crypto'
import type {
  EngineEvent,
  EvidenceRecord,
  FollowUp,
  Session,
  SessionState,
  TranscriptMessage,
} from './types.js'
import type { ModelMessage, Provider } from '../llm/provider.js'
import type { NormalizedUsage } from '../llm/usage.js'
import { emptyUsage } from '../llm/usage.js'
import { computeCost, aggregateModelCalls, type AggregatedUsage } from '../llm/cost.js'
import type { ModelCallRecord } from './types.js'
import { buildSystemPrompt } from './prompt.js'
import { authorize } from '../tools/permissions.js'
import { findTool, toolDefinitions, toolsForMode } from '../tools/registry.js'
import { runVerificationCommand } from '../tools/shell-tool.js'
import type { ToolContext } from '../tools/types.js'
import { getSecretsForScope } from '../security/vault.js'
import { clearSecrets, registerSecret, scrubAll } from '../security/redact.js'
import { appendEvent, saveSession } from './store.js'
import { contextStatus, estimateTokens } from './context.js'
import { DEFAULT_CONFIG } from '../config/config.js'

const MAX_TOOL_OUTPUT_CHARS = 12_000

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

export interface EngineOptions {
  session: Session
  provider: Provider
  model?: string
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
  private readonly emit: (event: EngineEvent) => void
  private abort: AbortController | null = null
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

  constructor(options: EngineOptions) {
    this.session = options.session
    this.provider = options.provider
    this.model = options.model
    // Wrap the frontend callback so every meaningful event also lands in the
    // append-only audit log (events.jsonl). High-frequency text deltas are
    // excluded — the full text lives in the session transcript — and log
    // failures are swallowed: accounting must never break execution.
    this.emit = (event: EngineEvent) => {
      options.onEvent?.(event)
      // 'text' and 'thinking' are high-frequency transient streams — excluded
      // (the full text lives in the transcript; reasoning is not evidence).
      if (event.type !== 'text' && event.type !== 'thinking') void appendEvent(this.session.id, event).catch(() => {})
    }
  }

  /** Queue a follow-up. Applied at the start of the next turn (a safe point). */
  queueFollowUp(text: string): void {
    const followUp: FollowUp = { id: randomUUID(), text, at: new Date().toISOString() }
    this.session.followUps.push(followUp)
    this.followUpsToInject.push(followUp)
  }

  stop(): void {
    this.abort?.abort()
  }

  private setState(state: SessionState, reason?: string): void {
    this.session.state = state
    this.session.stateReason = reason
    this.emit({ type: 'state', state, reason })
  }

  private async prepareEnv(): Promise<void> {
    clearSecrets()
    const scope = `session:${this.session.id}`
    const secrets = await getSecretsForScope(scope)
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
    await saveSession(this.session)
    return true
  }

  private toModelMessages(): ModelMessage[] {
    const msgs = this.session.transcript
    // Enforce the REAL token budget computed by context.ts (window minus reserved
    // output minus safety margin) — not a fixed char threshold. A stress session
    // reached 106k input tokens against a 64k window because this path ignored
    // requestBudgetTokens entirely.
    // Session config has no per-session context override — the global default
    // is the single source of truth for output reservation.
    const budget = contextStatus(this.session, {
      maxOutputTokens: DEFAULT_CONFIG.context.maxOutputTokens,
    }).requestBudgetTokens

    // Walk newest → oldest, keeping whole turns while they fit. Oldest tool
    // output is dropped first (it is the least reusable); the most recent
    // messages always survive so the model keeps its working state.
    const kept: ModelMessage[] = []
    let used = 0
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i]!
      const msg: ModelMessage = {
        role: m.role === 'system' ? 'user' : m.role,
        content: m.content,
        ...(m.toolCalls?.length ? { toolCalls: m.toolCalls } : {}),
        ...(m.toolCallId ? { toolCallId: m.toolCallId } : {}),
      }
      // A tool result is allowed to be replaced with a marker (cheaper), never
      // silently dropped — dropping it would orphan its assistant tool_call.
      // Likewise an assistant message carrying toolCalls must never be dropped:
      // its tool results would then be orphaned. Only plain text is droppable.
      const cost = estimateTokens(msg.content)
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
    }
    return kept.reverse()
  }

  private addMessage(message: Omit<TranscriptMessage, 'at'>): void {
    this.session.transcript.push({ ...message, at: new Date().toISOString() })
  }

  private injectFollowUps(): void {
    if (this.followUpsToInject.length === 0) return
    const turn = this.session.usage.turns + 1
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
    await this.sessionStarted()

    for (;;) {
      if (this.isTerminal()) break

      this.warnBudget()

      const budgetReason = this.checkBudget()
      if (budgetReason) {
        this.setState('paused', budgetReason)
        this.emit({ type: 'budget_exhausted', reason: budgetReason })
        // Exhaustion is never silent: emit the honest report of what is and
        // is not verified, so the user sees exactly where the work stopped.
        this.emitSessionSummary(
          `Budget exhausted — the session is PAUSED, not complete. ${budgetReason} ` +
            `Below is exactly what was verified and what remains.`,
        )
        await saveSession(this.session)
        break
      }

      this.injectFollowUps()
      const outcome = await this.runTurn()
      this.session.usage.turns += 1
      this.session.usage.elapsedMs = Date.now() - new Date(this.session.usage.startedAt).getTime()
      await saveSession(this.session)

      if (outcome === 'stop') break
    }

    return this.session
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
    await saveSession(this.session)
  }

  private async runTurn(): Promise<'continue' | 'stop'> {
    this.emit({ type: 'turn', turn: this.session.usage.turns + 1 })
    const ctx = this.toolContext()
    const tools = toolsForMode(this.session.config.mode)

    this.abort = new AbortController()
    let assistantText = ''
    let result: { content: string; toolCalls: Array<{ id: string; name: string; arguments: string }> } | null = null
    let usage: NormalizedUsage | undefined

    try {
      for await (const event of this.provider.chat({
        system: buildSystemPrompt(this.session),
        messages: this.toModelMessages(),
        tools: toolDefinitions(this.session.config.mode),
        model: this.model ?? this.session.config.model ?? '',
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
            await saveSession(this.session)
            return 'stop'
          }
          this.recordModelCall(undefined, `Provider error: ${event.message}`)
          this.addMessage({ role: 'assistant', content: assistantText || '(no output)' })
          this.setState('paused', `Model error: ${event.message}`)
          this.emit({ type: 'error', message: event.message })
          await saveSession(this.session)
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
        await saveSession(this.session)
        return 'stop'
      }
      const message = (err as Error).message
      this.recordModelCall(undefined, `Request failed: ${message}`)
      this.setState('paused', `Run interrupted: ${message}`)
      await saveSession(this.session)
      return 'stop'
    }

    this.session.usage.modelCalls += 1
    // Every completed call is one ledger entry — successes and failures alike,
    // so retries are counted exactly once each and never silently dropped.
    this.recordModelCall(usage)
    const turn = result ?? { content: assistantText, toolCalls: [] }
    this.addMessage({
      role: 'assistant',
      content: turn.content,
      ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
    })

    if (turn.toolCalls.length === 0) {
      // The model spoke without acting. That is fine once; stalling repeatedly is not.
      if (await this.noteNoProgress()) return 'stop'
      return 'continue'
    }

    let pauseReason: string | null = null
    let completionClaim: { summary: string; verificationPlan: string; verifiedRequirements?: string[] } | null = null
    // Real progress is a SUCCESSFUL tool or new evidence — not merely a
    // failing call that appends an error line to the transcript. Without this
    // distinction a loop of failing calls looks like forward motion and never
    // trips the stall detector (observed: 247 turns, zero evidence).
    let anyToolSucceeded = false

    for (const rawCall of turn.toolCalls) {
      const call = {
        ...rawCall,
        id: rawCall.id || `call_${randomUUID().slice(0, 8)}`,
      }
      this.session.usage.toolCalls += 1
      const tool = findTool(call.name)
      if (!tool) {
        this.appendToolResult(call.id, call.name, false, `Unknown tool: ${call.name}`)
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

      let output: string
      let ok: boolean
      try {
        const result2 = await (tool.execute as (a: unknown, c: ToolContext) => Promise<{
          ok: boolean
          output: string
          pauseForUser?: string
          completeClaim?: { summary: string; verificationPlan: string; verifiedRequirements?: string[] }
        }>)(parsed, ctx)
        ok = result2.ok
        output = scrubAll(result2.output)
        if (result2.pauseForUser) pauseReason = result2.pauseForUser
        if (result2.completeClaim) completionClaim = result2.completeClaim
      } catch (err) {
        ok = false
        output = `Tool crashed: ${(err as Error).message}`
      }

      // Loop detection: identical tool call repeated consecutively
      const callSignature = `${call.name}:${call.arguments}`
      if (callSignature === this.lastToolSignature) {
        this.identicalToolStreak += 1
      } else {
        this.lastToolSignature = callSignature
        this.identicalToolStreak = 1
      }
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

      if (output.length > MAX_TOOL_OUTPUT_CHARS) {
        output = output.slice(0, MAX_TOOL_OUTPUT_CHARS) + '\n…[output truncated]'
      }
      this.appendToolResult(call.id, call.name, ok, output)
      this.emit({ type: 'tool_end', id: call.id, name: call.name, ok, output })
      if (ok) anyToolSucceeded = true
    }

    // Only genuine progress resets the stall counter: a successful tool or a
    // completed claim. A run of failing calls keeps counting toward the limit.
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
        await saveSession(this.session)
        return 'stop'
      }
      this.failedClaims += 1
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
        await saveSession(this.session)
        return 'stop'
      }
      return 'continue'
    }

    if (pauseReason) {
      this.setState('waiting_user', pauseReason)
      this.emit({ type: 'waiting', reason: pauseReason })
      await saveSession(this.session)
      return 'stop'
    }

    return 'continue'
  }

  private appendToolResult(callId: string, name: string, ok: boolean, output: string): void {
    this.addMessage({ role: 'tool', content: `[${ok ? 'OK' : 'FAIL'}] ${output}`, toolCallId: callId, toolName: name })
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
      const run2 = await runVerificationCommand(verifyCommand, ctx.cwd, this.env)
      this.recordEvidence({
        at: new Date().toISOString(),
        kind: 'command',
        command: verifyCommand,
        exitCode: run2.exitCode ?? -1,
        ok: run2.exitCode === 0,
        output: run2.output.slice(-6000),
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
  private recordModelCall(usage: NormalizedUsage | undefined, note?: string): void {
    const normalized = usage ?? emptyUsage('provider')
    const model = this.model ?? this.session.config.model ?? 'unknown'
    const cost = computeCost(normalized, null, model, this.provider.id)
    const notes = [note, cost.reason].filter((n): n is string => Boolean(n))
    this.session.modelCalls ??= []
    // Defense in depth: cost notes can carry provider error text — scrub them
    // with the same pipeline as transcripts before anything is persisted.
    const record: ModelCallRecord = {
      at: new Date().toISOString(),
      model,
      providerId: this.provider.id,
      turn: this.session.usage.turns + 1,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      cacheWriteTokens: normalized.cacheWriteTokens,
      usageSource: normalized.source,
      costUsd: cost.totalUsd,
      costPartial: cost.partial,
      costNote: notes.length ? scrubAll(notes.join(' — ')).slice(0, 500) : undefined,
    }
    this.session.modelCalls.push(record)
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
