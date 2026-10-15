import type { ToolCall } from '../core/types.js'
import { openaiProvider } from './openai.js'
import { anthropicProvider } from './anthropic.js'
import type { NormalizedUsage } from './usage.js'

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
  /** Reasoning blocks to replay with this assistant turn (provider-specific). */
  reasoning?: unknown[]
  /** Images that travel with a user message (base64, no data: prefix). Only set for models that can see. */
  images?: Array<{ mime: string; data: string }>
}

export interface ProviderRequest {
  system: string
  messages: ModelMessage[]
  tools: Array<Record<string, unknown>>
  model: string
  maxTokens?: number
  /** Reasoning effort for models that support it; undefined = provider default. */
  thinking?: 'off' | 'low' | 'medium' | 'high'
  signal?: AbortSignal
  /** Stable per-session key: lets OpenAI route the session's requests to the same prompt cache. Ignored elsewhere. */
  cacheKey?: string
}

export interface AssistantTurn {
  content: string
  toolCalls: ToolCall[]
  /** Provider reasoning blocks that must accompany the tool calls on the next request. */
  reasoning?: unknown[]
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
  /**
   * A slice of the model's private reasoning, streamed while it thinks.
   * Transient display-only content: it is NEVER persisted to the audit log
   * (like 'text', the transcript holds the final answer, not the deliberation).
   * Absent entirely for models/providers that do not expose reasoning.
   */
  | { type: 'thinking'; text: string }
  /**
   * Normalized usage for this call. Absent when the endpoint reported nothing
   * (or an older adapter omits it) — consumers must treat absent as UNKNOWN,
   * never as zero. Providers that never emit it are simply not measured.
   */
  | { type: 'done'; result: AssistantTurn; modelCalls?: number; usage?: NormalizedUsage }
  | { type: 'error'; message: string }

export interface Provider {
  id: 'openai' | 'anthropic'
  chat(req: ProviderRequest): AsyncIterable<ProviderEvent>
}

export interface ProviderConfig {
  id: 'openai' | 'anthropic'
  baseUrl: string
  apiKey: string
  model: string
  maxTokens?: number
}

export function createProvider(config: ProviderConfig): Provider {
  if (config.id === 'anthropic') return anthropicProvider(config)
  return openaiProvider(config)
}
