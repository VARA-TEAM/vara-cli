import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { configFile } from './paths.js'
import type { Budget } from '../core/types.js'

const ProviderSchema = z.object({
  id: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().default(''),
  /** Name of the secret in the vault that holds the API key. Never the key itself. */
  apiKeySecret: z.string().default(''),
  /** Fallback: read the key from this env var if the vault has nothing. */
  apiKeyEnv: z.string().default(''),
  model: z.string(),
  maxTokens: z.number().int().optional(),
})

const ConfigSchema = z.object({
  provider: ProviderSchema,
  context: z
    .object({
      /** Auto-detect the window from the model registry when unset. */
      windowTokens: z.number().int().positive().optional(),
      /** Reserve for the model's answer. */
      maxOutputTokens: z.number().int().positive().default(4096),
    })
    .default({ maxOutputTokens: 4096 }),
  budgets: z
    .object({
      task: z.object({ maxTurns: z.number(), maxDurationMs: z.number(), maxModelCalls: z.number() }),
      goal: z.object({ maxTurns: z.number(), maxDurationMs: z.number(), maxModelCalls: z.number() }),
    })
    .default({
      task: { maxTurns: 60, maxDurationMs: 60 * 60_000, maxModelCalls: 300 },
      goal: { maxTurns: 400, maxDurationMs: 4 * 60 * 60_000, maxModelCalls: 1500 },
    }),
  defaultVerifyCommand: z.string().default(''),
  allowPublish: z.boolean().default(false),
})

export type VaraConfig = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: VaraConfig = {
  provider: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeySecret: 'OPENAI_API_KEY',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4o',
  },
  context: { maxOutputTokens: 4096 },
  budgets: {
    task: { maxTurns: 60, maxDurationMs: 60 * 60_000, maxModelCalls: 300 },
    goal: { maxTurns: 400, maxDurationMs: 4 * 60 * 60_000, maxModelCalls: 1500 },
  },
  defaultVerifyCommand: '',
  allowPublish: false,
}

export async function loadConfig(): Promise<VaraConfig> {
  if (!existsSync(configFile)) {
    await saveConfig(DEFAULT_CONFIG)
    return DEFAULT_CONFIG
  }
  const raw = JSON.parse(await readFile(configFile, 'utf8')) as unknown
  const parsed = ConfigSchema.safeParse(raw)
  if (!parsed.success) {
    throw new Error(`Invalid config at ${configFile}: ${parsed.error.issues.map((i) => i.message).join('; ')}`)
  }
  return parsed.data
}

export async function saveConfig(config: VaraConfig): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')
}

export function budgetFor(kind: 'task' | 'goal', config: VaraConfig): Budget {
  return kind === 'task' ? config.budgets.task : config.budgets.goal
}
