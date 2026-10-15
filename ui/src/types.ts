/** Shapes of the host API (mirrors src/server/host.ts and access.ts). */

export interface Grant {
  preset: 'viewer' | 'participant' | 'collaborator' | 'custom'
  watch: boolean
  sendShared: boolean
  ownSession: boolean
  modelPolicy: 'locked' | 'list' | 'any'
  allowedModels: string[]
  mode: 'plan' | 'build'
  canChangeMode: boolean
  canInterrupt: boolean
  maxModelCalls?: number
  maxCostUsd?: number
  expiresAt?: string
}

export interface HostInfo {
  version: string
  folder: string
  provider: string
  model: string
}

export type Me =
  | { role: 'owner'; name: string; host: HostInfo }
  | { role: 'guest'; id: string; name: string; grant: Grant; host: HostInfo }

export interface ModelsInfo {
  provider: string
  current: string
  allowed: string[] | 'any'
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

export interface ToolCall {
  id: string
  name: string
  arguments: string
}

export interface TranscriptItem {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: string
  toolCalls?: ToolCall[]
  toolName?: string
  toolCallId?: string
  at: string
}

export interface PendingApproval {
  id: string
  action: string
  title: string
  detail: string
}

export interface SessionView {
  id: string
  objective: string
  state: string
  stateReason?: string
  kind: string
  mode: 'plan' | 'build'
  customMode?: string
  /** Every mode this person may switch the session to. */
  modeChoices: string[]
  model?: string
  intent?: string
  shared: boolean
  participant?: { id: string; name: string }
  usage: { turns: number; modelCalls: number; toolCalls: number; costUsd: number | null; costPartial: boolean; inputTokens: number | null; outputTokens: number | null }
  disabledSkills: string[]
  disabledMcp: string[]
  pendingApprovals: PendingApproval[]
  requirements: string[]
  verified: string[]
  can: { send: boolean; pause: boolean; setMode: boolean; setModel: boolean; manage: boolean }
  updatedAt: string
  transcript: TranscriptItem[]
}

/** An event as streamed by the host. */
export interface HostEvent {
  type: string
  at?: string
  [key: string]: unknown
}

export interface GuestRow {
  id: string
  name: string
  preset: string
  lastSeenAt: string
  revoked: boolean
  sessions: number
  running: number
  modelCalls: number
  costUsd: number | null
}

export interface GuestRecord {
  id: string
  name: string
  grant: Grant
  createdAt: string
  lastSeenAt: string
  revoked: boolean
}

export interface InviteRecord {
  id: string
  label: string
  grant: Grant
  expiresAt: string
  uses: number
  maxUses: number
  revoked: boolean
}

export interface Overview {
  guests: GuestRow[]
  sessions: SessionSummary[]
}

export interface CreatedInvite {
  id: string
  expiresAt: string
  token: string
  link: string
  grant: Grant
}

/* ---------- owner management (providers, models, settings, skills, MCP) ---------- */

export type ThinkLevel = 'off' | 'low' | 'medium' | 'high'
export type KeyState = 'vault' | 'env' | 'none' | 'not needed'

export interface ModelRow {
  id: string
  status: 'ok' | 'fail' | 'unknown'
  statusDetail?: string
  checkedAt?: string
  active: boolean
  contextTokens: number
  contextOrigin: 'manual' | 'api' | 'known' | 'assumed'
  maxOutputTokens?: number
  thinking: { levels: ThinkLevel[]; level: ThinkLevel; note: string } | null
}

export interface ProviderRow {
  name: string
  label: string
  type: 'openai' | 'anthropic'
  baseUrl: string
  keyless: boolean
  key: KeyState
  active: boolean
  models: ModelRow[]
}

export interface PresetRow {
  name: string
  label: string
  type: 'openai' | 'anthropic'
  baseUrl: string
  keyless: boolean
  note: string
  added: boolean
}

export interface ProvidersState {
  active: { name: string; model: string }
  providers: ProviderRow[]
  presets: PresetRow[]
  found?: number
}

export interface BudgetRow {
  maxTurns: number
  maxMinutes: number
  maxModelCalls: number
}

export interface ModeRow {
  name: string
  description: string
  base: 'plan' | 'build'
  allowTools: string[]
  denyTools: string[]
  allowCommands: string[]
  denyCommands: string[]
}

export interface SettingsState {
  agent: { autoIntent: boolean; defaultMode: 'plan' | 'build'; cheapModel: string }
  defaultVerifyCommand: string
  allowPublish: boolean
  budgets: { task: BudgetRow; goal: BudgetRow }
  context: { windowTokens: number | null; maxOutputTokens: number }
}

export interface SkillRow {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project'
  enabled: boolean
  body: string
  editable: boolean
}

export interface McpServerRow {
  name: string
  status: 'disabled' | 'connecting' | 'ready' | 'error'
  tools: number
  error: string
  enabled: boolean
  kind: 'remote' | 'local'
  target: string
  toolList: Array<{ name: string; description: string; readOnly: boolean }>
}

export interface McpState {
  servers: McpServerRow[]
  presets: Array<{ name: string; label: string; note: string; added: boolean }>
}

export interface Insights {
  cost: {
    costUsd: number | null
    costPartial: boolean
    modelCalls: number
    toolCalls: number
    inputTokens: number | null
    cachedTokens: number | null
    outputTokens: number | null
    cacheHitPercent: number | null
  }
  savings: { cacheUsd: number | null; compactedTokens: number; compactUsd: number | null; dedupedReads: number; cheapCalls: number; subagents: number }
  context: { windowTokens: number; source: 'configured' | 'detected' | 'fallback'; requestBudgetTokens: number; reservedOutput: number; usedTokens: number; percent: number }
  budget: { turns: number; maxTurns: number; modelCalls: number; maxModelCalls: number; maxMinutes: number; evidence: number }
  evidence: Array<{ at: string; kind: string; ok: boolean; command?: string; exitCode?: number; output?: string; files?: string[] }>
}
