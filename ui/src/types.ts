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

export interface SessionView {
  id: string
  objective: string
  state: string
  stateReason?: string
  kind: string
  mode: 'plan' | 'build'
  model?: string
  intent?: string
  shared: boolean
  participant?: { id: string; name: string }
  usage: { turns: number; modelCalls: number; toolCalls: number; costUsd: number | null; costPartial: boolean; inputTokens: number | null; outputTokens: number | null }
  requirements: string[]
  verified: string[]
  can: { send: boolean; pause: boolean; setMode: boolean; setModel: boolean }
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
