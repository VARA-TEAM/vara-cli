/**
 * Core domain types for VARA.
 *
 * One execution engine; Task and Goal differ only in completion policy.
 */

export type SessionKind = 'task' | 'goal'

/** What the current conversation turn is about — see intent.ts. */
export type SessionIntent = 'chat' | 'question' | 'task' | 'goal'

/** User-facing operating mode. Enforced at the tool level, not by prompt alone. */
export type Mode = 'plan' | 'build'

/**
 * Session lifecycle.
 * - running:        engine loop active, accepts follow-ups at safe points
 * - waiting_user:   agent paused itself, needs a decision from the user
 * - paused:         user paused it (or app stopped mid-run); resumable
 * - interrupted:    process died mid-turn; state recovered, turn NOT assumed complete
 * - ready:          the agent answered (chat / question / finished a reply) and waits for the next message
 * - completed:      acceptance satisfied, evidence recorded
 * - failed:         gave up after retries/budget with reason
 * - stopped:        user aborted manually
 */
export type SessionState =
  | 'idle'
  | 'running'
  | 'waiting_user'
  | 'paused'
  | 'interrupted'
  | 'ready'
  | 'completed'
  | 'failed'
  | 'stopped'

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export interface ToolCall {
  id: string
  name: string
  /** Raw JSON string of arguments as produced by the model. */
  arguments: string
}

export interface TranscriptMessage {
  role: Role
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  /** Name of the tool this message answers, when role === 'tool'. */
  toolName?: string
  /** ISO timestamp. */
  at: string
  /** Total characters of content; truncated copies keep this as the real size. */
  fullLength?: number
  /** Provider reasoning blocks (e.g. Anthropic thinking + signature) that must be sent back with tool turns. */
  reasoning?: unknown[]
  /** True once a tool result was shrunk by compaction (the full output stays in the audit log). */
  compacted?: boolean
}

export interface FollowUp {
  id: string
  text: string
  at: string
  /** Turn number at which this instruction was injected into the model context. */
  appliedAtTurn?: number
}

export interface Budget {
  maxTurns: number
  maxDurationMs: number
  /** Optional hard cap on model calls. */
  maxModelCalls: number
}

export interface Usage {
  turns: number
  modelCalls: number
  toolCalls: number
  startedAt: string
  elapsedMs: number
  /**
   * Cost Truth Foundation.
   *
   * Token totals are `null` when no call reported them — never 0, because
   * "nothing measured" and "nothing spent" are different facts. `costUsd` is
   * null when pricing is unknown for the model(s) used.
   */
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  /** Sum of per-call costs, or null when any contributing call had unknown cost. */
  costUsd: number | null
  /** True when at least one call's cost could not be computed. */
  costPartial: boolean
  /** Number of calls whose usage or cost was unknown. */
  unpricedCalls: number
}

/**
 * Auditable, per-call usage+cost record. This is the source of truth for cost:
 * session totals are derived from these, so replaying events or resuming a
 * session can never double-count.
 */
export interface ModelCallRecord {
  at: string
  model: string
  providerId: string
  /** Which turn this call belonged to. */
  turn: number
  inputTokens: number | null
  outputTokens: number | null
  cachedInputTokens: number | null
  cacheWriteTokens: number | null
  /** 'provider' when the endpoint reported numbers; 'estimated' when we did. */
  usageSource: 'provider' | 'estimated'
  costUsd: number | null
  costPartial: boolean
  /** Why the cost is unknown/partial, when applicable. */
  costNote?: string
}

/** Independent, machine-recorded proof of work. The model never writes these. */
export interface EvidenceRecord {
  at: string
  kind: 'files_changed' | 'command' | 'git_status' | 'verification' | 'note'
  /** For commands: the exact command string. */
  command?: string
  exitCode?: number
  /** Short, secret-scrubbed output. */
  output?: string
  files?: string[]
  ok: boolean
}

export interface SessionConfig {
  kind: SessionKind
  mode: Mode
  objective: string
  /** Acceptance conditions. Free text; the engine forces evidence per condition. */
  acceptance: string[]
  budget: Budget
  /** Optional repo-level verification command (e.g. `npm test`). */
  verifyCommand?: string
  cwd: string
  /** Model to use; falls back to config default. */
  model?: string
  /** Whether the agent may push / publish (gh, git push). Default false. */
  allowPublish: boolean
  /**
   * True when the user did not force TASK/GOAL: every message is routed (chat /
   * question / task / goal) by intent. False pins the session to `kind`.
   */
  auto?: boolean
}

export interface Session {
  id: string
  createdAt: string
  updatedAt: string
  state: SessionState
  /**
   * Every currently-active requirement the completion must cover: the original
   * acceptance conditions plus each applied follow-up. `complete` is rejected
   * unless the model accounts for all of them by number.
   */
  activeRequirements?: string[]
  /** Why the session is in its current state (e.g. "waiting for decision on X"). */
  stateReason?: string
  config: SessionConfig
  transcript: TranscriptMessage[]
  followUps: FollowUp[]
  evidence: EvidenceRecord[]
  usage: Usage
  /**
   * Per-call usage+cost ledger. The auditable source of truth: session totals
   * in `usage` are derived from these, so resume/replay cannot double-count.
   * Optional so sessions saved before this milestone still load.
   */
  modelCalls?: ModelCallRecord[]
  /** Set when the model claimed completion; engine then runs verification. */
  completionClaim?: {
    summary: string
    verificationPlan: string
    /** Requirement numbers (as strings) the model claims to have verified. */
    verifiedRequirements?: string[]
    at: string
  }
  /** The intent of the latest turn (set by the router; absent on old sessions). */
  intent?: SessionIntent
  /** What the cost engine avoided — shown by /cost. */
  savings?: Savings
  /** Who runs this session when it is not the host owner (shared sessions). */
  participant?: { id: string; name: string }
  /** The owner opened this session to guests with watch / send permission. */
  shared?: boolean
  /** Last turn index that produced a tool call or text — used for no-progress detection. */
  lastProgressTurn: number
}

/** Counters for work the cost engine did NOT send to the model. */
export interface Savings {
  /** Tool-output characters removed by compaction. */
  compactedChars: number
  /** read_file calls answered from context instead of the disk. */
  dedupedReads: number
  /** Model calls served by the cheaper routed model. */
  cheapCalls: number
  /** Sub-agent runs. */
  subagents: number
}

/** Emitted by the engine so any frontend (TUI today, GUI later) can render. */
export type EngineEvent =
  | { type: 'state'; state: SessionState; reason?: string }
  | { type: 'text'; delta: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; args: string; id: string }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; output: string; truncated?: boolean }
  | { type: 'turn'; turn: number }
  | { type: 'intent'; intent: SessionIntent; reason: string }
  | { type: 'subagent'; id: string; title: string; status: 'running' | 'done' | 'failed'; detail?: string }
  | { type: 'followup_applied'; id: string; turn: number }
  | { type: 'evidence'; record: EvidenceRecord }
  | { type: 'verification'; ok: boolean; detail: string }
  | { type: 'completed'; summary: string }
  | {
      type: 'session_summary'
      summary: string
      requirements: Array<{ id: string; text: string; verified: boolean }>
      evidence: EvidenceRecord[]
      turns: number
      toolCalls: number
      elapsedMs: number
      /** Session cost in USD, or null when pricing/usage was unavailable. */
      costUsd?: number | null
      costPartial?: boolean
    }
  | { type: 'model_usage'; record: ModelCallRecord }
  | { type: 'error'; message: string }
  | { type: 'waiting'; reason: string }
  | { type: 'budget_exhausted'; reason: string }
  | { type: 'budget_warning'; percent: number; message: string }
