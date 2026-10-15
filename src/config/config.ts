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
  /** The model accepts images (provider list or the user's override); unset = guessed from the id. */
  vision: z.boolean().optional(),
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
  /** Sub-agents / swarm: who is working on what, live. Only shows while there is something to show. */
  agents: z.boolean().default(true),
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
  /** Signed in with OAuth (tokens in the vault, never here). */
  oauth: z.boolean().optional(),
  headers: z.record(z.string()).default({}),
  enabled: z.boolean().default(true),
  timeoutMs: z.number().int().positive().optional(),
})
export type McpServerConfigEntry = z.infer<typeof McpServerSchema>

const TierTargetSchema = z.union([z.string().min(1).max(200), z.object({ model: z.string().min(1).max(200), provider: z.string().min(1).max(32).optional() })])

/** The model router (core/router.ts): per-turn choice of strong / standard / cheap. */
export const RoutingSchema = z.object({
  enabled: z.boolean().default(true),
  /** A model (or { provider, model } on another configured provider) per tier. Unset: strong and standard = the session model; cheap = agent.cheapModel. */
  tiers: z.object({ strong: TierTargetSchema.optional(), standard: TierTargetSchema.optional(), cheap: TierTargetSchema.optional() }).default({}),
  /** The lowest tier work turns may use. Default standard: cheap models never touch work unless you lower this. */
  floor: z.enum(['cheap', 'standard', 'strong']).default('standard'),
  escalateOnFailure: z.boolean().default(true),
})

/** Your limit: what the meter counts against (core/usage-meter.ts). */
export const LimitsSchema = z.object({
  unit: z.enum(['none', 'tokens', 'usd', 'percent']).default('none'),
  amount: z.number().min(0).default(0),
  window: z.object({ kind: z.enum(['rolling', 'day', 'week', 'month']).default('rolling'), hours: z.number().min(0.25).max(24 * 31).default(5) }).default({}),
  warnAt: z.array(z.number().min(1).max(100)).length(3).default([70, 85, 95]),
  /** Opt-in: near ecoAt percent, routing tightens (one tier lower on mechanical turns, never below your floor). */
  autoEco: z.boolean().default(false),
  ecoAt: z.number().min(1).max(100).default(85),
  cachedWeight: z.number().min(0).max(1).default(0.1),
  readings: z.array(z.object({ at: z.string(), percent: z.number().min(0).max(100) })).max(200).default([]),
})

/**
 * Live web lookup (src/web/*, tools `web_search` and `web_fetch`). Read-only, runs from THIS machine (your own IP), no paid
 * API needed. `providers` is the order tried; the optional API ones (brave, tavily, serper) are used only if listed AND
 * a key is stored in the vault under the name in `keyNames`.
 */
export const WebProviderIds = ['duckduckgo', 'mojeek', 'searxng', 'browser', 'brave', 'tavily', 'serper'] as const
export const WebSearchSchema = z.object({
  /** Offer `web_search` (read-only). On by default. */
  enabled: z.boolean().default(true),
  /** Offer `web_fetch`, which reads one page as text. On by default. */
  fetch: z.boolean().default(true),
  providers: z.array(z.enum(WebProviderIds)).max(7).default(['duckduckgo', 'mojeek', 'searxng', 'browser']),
  /** SearXNG servers (ideally your own) tried by the `searxng` provider; it needs JSON output enabled. Empty = the provider is skipped. Public ones mostly refuse bots, so none is bundled. */
  searxngInstances: z.array(z.string().url().max(200)).max(20).default([]),
  /** Vault secret names holding the optional API keys. The keys themselves are never in this file. */
  keyNames: z.object({ brave: z.string().max(80).default('BRAVE_API_KEY'), tavily: z.string().max(80).default('TAVILY_API_KEY'), serper: z.string().max(80).default('SERPER_API_KEY') }).default({}),
  maxResults: z.number().int().min(1).max(20).default(8),
  /** Most characters of one page returned to the model (about 4 per token). */
  maxPageChars: z.number().int().min(1000).max(40000).default(12000),
  cacheMinutes: z.number().int().min(0).max(240).default(10),
  /** Searches allowed per minute, to stay polite to the free search sites. */
  perMinute: z.number().int().min(1).max(120).default(20),
})
export type WebSearchSettings = z.infer<typeof WebSearchSchema>

export const AgentSchema = z.object({
  /** Cheaper model for chat, questions and sub-agents ("provider's own id"). Empty = use the session model. */
  cheapModel: z.string().default(''),
  /** Route every message: chat / question / task / goal. Off = always run as the chosen kind. */
  autoIntent: z.boolean().default(true),
  defaultMode: z.enum(['plan', 'build']).default('build'),
  /** Offer the `browser` tool (an isolated browser the agent can drive). Off until the owner turns it on. */
  browser: z.boolean().default(false),
  /** Offer the `desktop` tool (screen, mouse and keyboard). Off until the owner turns it on; still asks once per session. */
  desktop: z.boolean().default(false),
  webSearch: WebSearchSchema.default({}),
})

/** A user-defined mode: a named restriction of plan or build (see core/modes.ts). */
export const ModeSchema = z.object({
  description: z.string().max(300).default(''),
  base: z.enum(['plan', 'build']).default('build'),
  allowTools: z.array(z.string().min(1).max(80)).max(100).default([]),
  denyTools: z.array(z.string().min(1).max(80)).max(100).default([]),
  allowCommands: z.array(z.string().min(1).max(200)).max(100).default([]),
  denyCommands: z.array(z.string().min(1).max(200)).max(100).default([]),
})

/** Cross-session memory: two small editable files (yours, and one per project) injected into the prompt within a token budget. */
export const MemorySchema = z.object({
  enabled: z.boolean().default(false),
  /** ask = every agent write needs your approval (no approver = refused); auto = the agent writes freely; off = the agent can only read. */
  agentWrites: z.enum(['ask', 'auto', 'off']).default('ask'),
  /** Most tokens (estimated, 4 characters each) of memory put into the prompt. Older notes stay on disk, out of the prompt. */
  maxTokens: z.number().int().min(50).max(2000).default(400),
})
export type MemorySettings = z.infer<typeof MemorySchema>

/** Scheduled tasks: a prompt run headlessly in a folder on an interval or a cron-like spec. */
export const ScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  maxJobs: z.number().int().min(1).max(50).default(10),
  /** A run is stopped after this long. */
  maxRunMinutes: z.number().int().min(1).max(240).default(20),
  /** The shortest repeat interval accepted. */
  minIntervalMinutes: z.number().int().min(1).max(1440).default(5),
})
export type ScheduleSettings = z.infer<typeof ScheduleSchema>

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
      /** Fold old turns into a cheap-model summary once they are large (needs a cheap model; see docs/COST.md). */
      summarize: z.boolean().default(true),
      /** Characters of one command's output kept in the conversation; the rest stays retrievable with tool_output. */
      toolOutputChars: z.number().int().min(1000).max(12000).default(6000),
      /** Long files read without a range come back as an outline + first lines. */
      smartRead: z.boolean().default(true),
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
  /** Which model handles which turn (strong / standard / cheap) and the quality floor. */
  routing: RoutingSchema.default({}),
  /** The limit you want VARA to watch and stretch. */
  limits: LimitsSchema.default({}),
  /** MCP servers (Model Context Protocol): extra tools from local or remote servers. */
  mcp: z.object({ servers: z.record(McpServerSchema).default({}) }).default({}),
  /** Limits for `delegate` swarms. They can only lower the built-in ceilings (4 tasks, 3 parallel). */
  swarm: z
    .object({
      maxTasks: z.number().int().min(1).max(4).default(4),
      maxParallel: z.number().int().min(1).max(3).default(3),
      /** Model calls the whole swarm may spend (the guard that works even when cost is unknown). */
      maxModelCalls: z.number().int().min(1).default(120),
      /** Stop starting sub-agents once the KNOWN cost reaches this. null = no cost cap. */
      maxCostUsd: z.number().positive().nullable().default(null),
      /** Your own roles: { name: { kind: 'explore' | 'work', instructions } }. */
      roles: z.record(z.object({ kind: z.enum(['explore', 'work']), instructions: z.string().max(1000) })).default({}),
    })
    .default({}),
  /** Custom modes beyond plan / build, by name. */
  modes: z.record(ModeSchema).default({}),
  /** Automatic "update available" notice (one quiet request to GitHub per day; nothing else is sent). */
  updates: z.object({ check: z.boolean().default(true) }).default({}),
  skills: z
    .object({
      /** Skill names the agent must not see. */
      disabled: z.array(z.string()).default([]),
      /** Let the agent PROPOSE a new or improved skill after a multi-step task. A proposal is only a file: nothing is installed until the owner approves it. */
      propose: z.boolean().default(false),
    })
    .default({}),
  /** Small notes that survive between sessions (core/memory.ts). Off until you turn it on. */
  memory: MemorySchema.default({}),
  /** Recurring headless runs (schedule/). Off until you turn it on; only you (the local owner) can add or run jobs. */
  schedule: ScheduleSchema.default({}),
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
