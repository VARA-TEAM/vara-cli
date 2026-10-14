import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { Mode, Session, SessionKind } from './types.js'
import { budgetFor, type VaraConfig } from '../config/config.js'

export const CreateSessionInput = z.object({
  kind: z.enum(['task', 'goal']).default('task'),
  mode: z.enum(['plan', 'build']).default('build'),
  objective: z.string().trim().min(1, 'Write a message first.'),
  /** Route each message by intent (chat / question / task / goal) instead of pinning `kind`. */
  auto: z.boolean().default(false),
  acceptance: z.array(z.string()).default([]),
  cwd: z.string().min(1),
  verifyCommand: z.string().optional(),
  allowPublish: z.boolean().optional(),
  model: z.string().optional(),
})

export type CreateSessionInput = z.infer<typeof CreateSessionInput>

export function createSession(input: CreateSessionInput, config: VaraConfig): Session {
  const now = new Date().toISOString()
  // A session must NEVER start with an empty requirement list: an empty list
  // would let `complete` pass with zero coverage (0/0 "verified"). If the user
  // gave no acceptance conditions, the objective itself becomes requirement #1.
  const requirements = input.acceptance.length
    ? [...input.acceptance]
    : [`The stated objective is achieved and verified: ${input.objective}`]
  return {
    id: randomUUID().slice(0, 8),
    createdAt: now,
    updatedAt: now,
    state: 'idle',
    config: {
      kind: input.kind as SessionKind,
      mode: input.mode as Mode,
      objective: input.objective,
      acceptance: input.acceptance,
      budget: budgetFor(input.kind, config),
      verifyCommand: input.verifyCommand || config.defaultVerifyCommand || undefined,
      cwd: input.cwd,
      model: input.model || config.provider.model,
      allowPublish: input.allowPublish ?? config.allowPublish,
      ...(input.auto ? { auto: true } : {}),
    },
    transcript: [],
    followUps: [],
    evidence: [],
    activeRequirements: requirements,
    usage: {
      turns: 0,
      modelCalls: 0,
      toolCalls: 0,
      startedAt: now,
      elapsedMs: 0,
      inputTokens: null,
      outputTokens: null,
      cachedInputTokens: null,
      cacheWriteTokens: null,
      costUsd: null,
      costPartial: false,
      unpricedCalls: 0,
    },
    modelCalls: [],
    lastProgressTurn: 0,
  }
}
