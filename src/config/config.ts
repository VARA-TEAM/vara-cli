import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { configFile } from './paths.js'
import { configRef, CONFIG_REF_EXPECTATION } from './refs.js'
import type { Budget } from '../core/types.js'
import { ensureProviders } from './providers.js'

/** Exported for tests: the provider block's validation (incl. NAME-only refs). */
/** Per-model settings and last-known health. Every field is optional/explicit. */
export const ModelEntrySchema = z.object({
  /** Context window. `contextSource` says whether it is manual or came from the API. */
  contextWindow: z.number().int().positive().optional(),
  contextSource: z.enum(['manual', 'discovered']).optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  /** Chosen reasoning level (only meaningful when the model supports it). */
  thinking: z.enum(['off', 'low', 'medium', 'high']).optional(),
  /** The provider's own model list says the model reasons (OpenRouter `supported_parameters`). */
  reasoning: z.boolean().optional(),
  /** ok = last test call succeeded, fail = it failed, unknown = never tested. */
  status: z.enum(['ok', 'fail', 'unknown']).default('unknown'),
  statusDetail: z.string().optional(),
  checkedAt: z.string().optional(),
})
export type ModelEntry = z.infer<typeof ModelEntrySchema>

const RefField = (field: string) =>
  z
    .string()
    .default('')
    .refine((v) => v === '' || configRef(v), `${field} ${CONFIG_REF_EXPECTATION}`)

/** A configured provider: connection details plus its models. */
export const ProviderEntrySchema = z.object({
  /** Wire protocol: every OpenAI-compatible service uses 'openai'. */
  type: z.enum(['openai', 'anthropic']),
  label: z.string().optional(),
  baseUrl: z.string(),
  apiKeySecret: RefField('apiKeySecret'),
  apiKeyEnv: RefField('apiKeyEnv'),
  /** Local servers (Ollama, LM Studio) need no key. */
  keyless: z.boolean().default(false),
  /** Enables extra native lookups, e.g. context size from Ollama's /api/show. */
  flavor: z.enum(['ollama']).optional(),
  models: z.record(ModelEntrySchema).default({}),
})
export type ProviderEntry = z.infer<typeof ProviderEntrySchema>

export const ProviderSchema = z.object({
  id: z.enum(['openai', 'anthropic']),
  /** Name of the entry in `providers` this block was activated from. */
  name: z.string().optional(),
  keyless: z.boolean().default(false),
  baseUrl: z.string().default(''),
  /** Name of the secret in the vault that holds the API key. Never the key itself. */
  apiKeySecret: z
    .string()
    .default('')
    .refine((v) => v === '' || configRef(v), `apiKeySecret ${CONFIG_REF_EXPECTATION}`),
  /** Fallback: read the key from this env var if the vault has nothing. */
  apiKeyEnv: z
    .string()
    .default('')
    .refine((v) => v === '' || configRef(v), `apiKeyEnv ${CONFIG_REF_EXPECTATION}`),
  model: z.string(),
  maxTokens: z.number().int().optional(),
})

/** Sidebar sections — each one can be switched off in /settings. */
export const SidebarSectionsSchema = z.object({
  session: z.boolean().default(true),
  context: z.boolean().default(true),
  requirements: z.boolean().default(true),
  files: z.boolean().default(true),
  cost: z.boolean().default(true),
  budget: z.boolean().default(false),
  skills: z.boolean().default(false),
})
export type SidebarSections = z.infer<typeof SidebarSectionsSchema>

export const UiSchema = z.object({
  theme: z.string().default('vara'),
  /** Full-screen alternate buffer: the UI stays put, the shell scrollback stays clean. */
  fullscreen: z.boolean().default(true),
  /** Mouse wheel scrolls the transcript (hold Shift to select text in most terminals). */
  mouse: z.boolean().default(true),
  sidebar: z.boolean().default(true),
  sections: SidebarSectionsSchema.default({}),
  /** Show the model's reasoning stream (when the provider exposes it). */
  showThinking: z.boolean().default(true),
  /** Show the tool-call detail line under each tool. */
  toolDetails: z.boolean().default(true),
})
export type UiSettings = z.infer<typeof UiSchema>

export const McpServerSchema = z.object({
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).default({}),
  /** Vault secret NAMES injected as environment variables — never values. */
  secretEnv: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  url: z.string().optional(),
  bearerSecret: z.string().optional(),
  headers: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().optional(),
})
export type McpServerConfigEntry = z.infer<typeof McpServerSchema>

export const AgentSchema = z.object({
  /** Cheaper model for chat, questions and sub-agents ("provider's own id"). Empty = use the session model. */
  cheapModel: z.string().default(''),
  /** Route every message: chat / question / task / goal. Off = always run as the chosen kind. */
  autoIntent: z.boolean().default(true),
  defaultMode: z.enum(['plan', 'build']).default('build'),
})

const ConfigSchema = z.object({
  /** The ACTIVE provider/model. Written by `activate()`; everything else reads it. */
  provider: ProviderSchema,
  /** Every configured provider, keyed by name, with its models. */
  providers: z.record(ProviderEntrySchema).default({}),
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
  /** How the terminal UI looks and behaves. */
  ui: UiSchema.default({}),
  /** How the agent decides what to do. */
  agent: AgentSchema.default({}),
  /** MCP servers (Model Context Protocol): extra tools from local or remote servers. */
  mcp: z.object({ servers: z.record(McpServerSchema).default({}) }).default({}),
  skills: z
    .object({
      /** Skill names the agent must not see. */
      disabled: z.array(z.string()).default([]),
    })
    .default({}),
})

export type VaraConfig = z.infer<typeof ConfigSchema>

export const DEFAULT_CONFIG: VaraConfig = ConfigSchema.parse({
  provider: {
    id: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    apiKeySecret: 'OPENAI_API_KEY',
    apiKeyEnv: 'OPENAI_API_KEY',
    model: 'gpt-4o',
  },
})

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
  return ensureProviders(parsed.data)
}

export async function saveConfig(config: VaraConfig): Promise<void> {
  await mkdir(dirname(configFile), { recursive: true })
  await writeFile(configFile, JSON.stringify(config, null, 2), 'utf8')
}

export function budgetFor(kind: 'task' | 'goal', config: VaraConfig): Budget {
  return kind === 'task' ? config.budgets.task : config.budgets.goal
}

let writeQueue: Promise<void> = Promise.resolve()

/**
 * Fire-and-forget save for the UI: writes are serialized so rapid edits
 * (e.g. many model tests finishing at once) can never interleave on disk.
 * The last call always wins. Resolves when everything queued so far is written.
 */
export function persistConfig(config: VaraConfig): Promise<void> {
  const snapshot = JSON.parse(JSON.stringify(config)) as VaraConfig
  writeQueue = writeQueue.then(() => saveConfig(snapshot)).catch(() => {})
  return writeQueue
}
