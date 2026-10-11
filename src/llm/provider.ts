import type { ToolCall } from '../core/types.js'
import { openaiProvider } from './openai.js'
import { anthropicProvider } from './anthropic.js'
import type { NormalizedUsage } from './usage.js'

export interface ModelMessage {
  role: 'user' | 'assistant' | 'tool'
  content: string
  toolCalls?: ToolCall[]
  toolCallId?: string
}

export interface ProviderRequest {
  system: string
  messages: ModelMessage[]
  tools: Array<Record<string, unknown>>
  model: string
  maxTokens?: number
  signal?: AbortSignal
}

export interface AssistantTurn {
  content: string
  toolCalls: ToolCall[]
}

export type ProviderEvent =
  | { type: 'text'; delta: string }
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
