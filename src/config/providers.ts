import type { VaraConfig, ProviderEntry, ModelEntry } from './config.js'
import type { ProviderPreset } from '../llm/presets.js'
import { contextWindowFromPattern, type ContextSettings } from '../core/context.js'
import { findModel } from '../llm/registry.js'
import { effectiveLevel, thinkingSupport, visionSupport, type ThinkLevel, type ThinkSupport } from '../llm/capabilities.js'

/**
 * Pure operations over the multi-provider config. No I/O: callers persist the
 * returned config. Every function returns a NEW config (never mutates), so UI
 * state and saved state cannot drift through shared references.
 */

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/

export function validProviderName(name: string): boolean {
  return NAME_RE.test(name)
}

/** Env/secret name for a provider, e.g. `my-llm` → `MY_LLM_API_KEY`. */
export function secretNameFor(providerName: string): string {
  return `${providerName.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_API_KEY`
}

export function activeProviderName(config: VaraConfig): string {
  return config.provider.name ?? config.provider.id
}

export function getProvider(config: VaraConfig, name: string): ProviderEntry | undefined {
  return config.providers[name]
}

/**
 * Configs written before multi-provider support only have `provider`. Lift it
 * into `providers` so the manager always sees the provider in use. Idempotent.
 */
export function ensureProviders(config: VaraConfig): VaraConfig {
  const name = activeProviderName(config)
  const existing = config.providers[name]
  const p = config.provider
  if (existing) {
    // Keep the active model listed.
    if (p.model && !existing.models[p.model]) {
      return { ...config, providers: { ...config.providers, [name]: { ...existing, models: { ...existing.models, [p.model]: { status: 'unknown' } } } } }
    }
    return config
  }
  const entry: ProviderEntry = {
    type: p.id,
    baseUrl: p.baseUrl,
    apiKeySecret: p.apiKeySecret,
    apiKeyEnv: p.apiKeyEnv,
    keyless: p.keyless ?? false,
    models: p.model ? { [p.model]: { status: 'unknown' } } : {},
  }
  return { ...config, provider: { ...p, name }, providers: { ...config.providers, [name]: entry } }
}

export function addProviderFromPreset(config: VaraConfig, preset: ProviderPreset): VaraConfig {
  const models: Record<string, ModelEntry> = {}
  for (const m of preset.suggestedModels) models[m] = { status: 'unknown' }
  const entry: ProviderEntry = {
    type: preset.type,
    label: preset.label,
    baseUrl: preset.baseUrl,
    apiKeySecret: preset.keyless ? '' : secretNameFor(preset.name),
    apiKeyEnv: preset.apiKeyEnv,
    keyless: preset.keyless ?? false,
    ...(preset.flavor ? { flavor: preset.flavor } : {}),
    models,
  }
  return { ...config, providers: { ...config.providers, [preset.name]: entry } }
}

export interface CustomProviderInput {
  name: string
  type: 'openai' | 'anthropic'
  baseUrl: string
  keyless?: boolean
  /** Optional initial models; empty means "fetch from the provider". */
  models?: string[]
}

export function addCustomProvider(config: VaraConfig, input: CustomProviderInput): VaraConfig {
  if (!validProviderName(input.name)) {
    throw new Error('Provider name must be lowercase letters, digits, "-" or "_" (max 32).')
  }
  if (config.providers[input.name]) throw new Error(`A provider named "${input.name}" already exists.`)
  if (!/^https?:\/\//i.test(input.baseUrl)) throw new Error('Base URL must start with http:// or https://')
  const models: Record<string, ModelEntry> = {}
  for (const m of input.models ?? []) if (m.trim()) models[m.trim()] = { status: 'unknown' }
  const entry: ProviderEntry = {
    type: input.type,
    baseUrl: input.baseUrl.replace(/\/+$/, ''),
    apiKeySecret: input.keyless ? '' : secretNameFor(input.name),
    apiKeyEnv: input.keyless ? '' : secretNameFor(input.name),
    keyless: input.keyless ?? false,
    models,
  }
  return { ...config, providers: { ...config.providers, [input.name]: entry } }
}

export function removeProvider(config: VaraConfig, name: string): VaraConfig {
  if (name === activeProviderName(config)) throw new Error('Cannot remove the provider in use — switch to another one first.')
  const { [name]: _removed, ...rest } = config.providers
  return { ...config, providers: rest }
}

function withProvider(config: VaraConfig, name: string, fn: (p: ProviderEntry) => ProviderEntry): VaraConfig {
  const entry = config.providers[name]
  if (!entry) throw new Error(`Unknown provider "${name}".`)
  return { ...config, providers: { ...config.providers, [name]: fn(entry) } }
}

export interface FoundModel {
  id: string
  contextWindow?: number
  maxOutputTokens?: number
  /** The provider's own list says this model reasons. */
  reasoning?: boolean
  /** The provider's own list says the model accepts image input. */
  vision?: boolean
}

/**
 * Merge a fetched model list into a provider. Existing manual settings and
 * health status survive a refresh; API-reported windows never overwrite a
 * value the user set by hand.
 */
export function mergeDiscovered(config: VaraConfig, name: string, found: FoundModel[]): VaraConfig {
  return withProvider(config, name, (p) => {
    const models: Record<string, ModelEntry> = { ...p.models }
    // The provider's own list is the truth: drop seeded/stale entries it does
    // not offer — but never one that was tested, hand-configured, or in use.
    const offered = new Set(found.map((f) => f.id))
    for (const [id, m] of Object.entries(p.models)) {
      const inUse = name === activeProviderName(config) && id === config.provider.model
      const untouched = m.status === 'unknown' && m.contextSource !== 'manual' && m.maxOutputTokens === undefined
      if (!offered.has(id) && untouched && !inUse) delete models[id]
    }
    for (const f of found) {
      const prev = models[f.id] ?? { status: 'unknown' as const }
      const manual = prev.contextSource === 'manual'
      models[f.id] = {
        ...prev,
        ...(f.contextWindow && !manual ? { contextWindow: f.contextWindow, contextSource: 'discovered' as const } : {}),
        ...(f.maxOutputTokens && prev.maxOutputTokens === undefined ? { maxOutputTokens: f.maxOutputTokens } : {}),
        ...(f.reasoning !== undefined ? { reasoning: f.reasoning } : {}),
        ...(f.vision !== undefined && prev.vision === undefined ? { vision: f.vision } : {}),
      }
    }
    return { ...p, models }
  })
}

export function addModel(config: VaraConfig, name: string, modelId: string): VaraConfig {
  const id = modelId.trim()
  if (!id) throw new Error('Model id is empty.')
  return withProvider(config, name, (p) => (p.models[id] ? p : { ...p, models: { ...p.models, [id]: { status: 'unknown' } } }))
}

export function removeModel(config: VaraConfig, name: string, modelId: string): VaraConfig {
  if (name === activeProviderName(config) && modelId === config.provider.model) {
    throw new Error('Cannot remove the model in use — switch to another one first.')
  }
  return withProvider(config, name, (p) => {
    const { [modelId]: _gone, ...rest } = p.models
    return { ...p, models: rest }
  })
}

export function setModelStatus(
  config: VaraConfig,
  name: string,
  modelId: string,
  status: ModelEntry['status'],
  detail?: string,
): VaraConfig {
  return withProvider(config, name, (p) => ({
    ...p,
    models: {
      ...p.models,
      [modelId]: { ...(p.models[modelId] ?? { status: 'unknown' as const }), status, statusDetail: detail, checkedAt: new Date().toISOString() },
    },
  }))
}

/**
 * Manual context settings for one model. `undefined` clears a field so the
 * model falls back to automatic detection again.
 */
export function setModelContext(
  config: VaraConfig,
  name: string,
  modelId: string,
  patch: { contextWindow?: number | null; maxOutputTokens?: number | null },
): VaraConfig {
  return withProvider(config, name, (p) => {
    const prev = p.models[modelId] ?? { status: 'unknown' as const }
    const next: ModelEntry = { ...prev }
    if (patch.contextWindow === null) {
      delete next.contextWindow
      delete next.contextSource
    } else if (patch.contextWindow !== undefined) {
      next.contextWindow = patch.contextWindow
      next.contextSource = 'manual'
    }
    if (patch.maxOutputTokens === null) delete next.maxOutputTokens
    else if (patch.maxOutputTokens !== undefined) next.maxOutputTokens = patch.maxOutputTokens
    return { ...p, models: { ...p.models, [modelId]: next } }
  })
}

/** Make `name`/`modelId` the active provider+model (copied into `config.provider`). */
export function activate(config: VaraConfig, name: string, modelId: string): VaraConfig {
  const entry = config.providers[name]
  if (!entry) throw new Error(`Unknown provider "${name}".`)
  const withModel = entry.models[modelId] ? config : addModel(config, name, modelId)
  const e = withModel.providers[name]!
  return {
    ...withModel,
    provider: {
      id: e.type,
      name,
      baseUrl: e.baseUrl,
      apiKeySecret: e.apiKeySecret,
      apiKeyEnv: e.apiKeyEnv,
      keyless: e.keyless,
      model: modelId,
    },
  }
}

/** First model worth selecting for a provider: a healthy one, else any. */
export function defaultModelFor(entry: ProviderEntry): string | undefined {
  const all = Object.entries(entry.models)
  return (all.find(([, m]) => m.status === 'ok') ?? all[0])?.[0]
}

export type WindowOrigin = 'manual' | 'api' | 'known' | 'assumed'

/** Where a model's context window comes from — shown next to it in the UI. */
export function contextOrigin(config: VaraConfig, name: string, modelId: string): { windowTokens: number; origin: WindowOrigin } {
  const m = config.providers[name]?.models[modelId]
  if (m?.contextWindow) return { windowTokens: m.contextWindow, origin: m.contextSource === 'manual' ? 'manual' : 'api' }
  if (config.context.windowTokens) return { windowTokens: config.context.windowTokens, origin: 'manual' }
  const known = contextWindowFromPattern(modelId) ?? findModel(modelId)?.contextWindow
  if (known) return { windowTokens: known, origin: 'known' }
  return { windowTokens: 64_000, origin: 'assumed' }
}

/**
 * Context settings for one model, resolved smartly:
 *   window: manual → API-reported → built-in registry → marked fallback
 *   output reserve: manual → global default, clamped to a quarter of the
 *   window so a small local model never ends up with no room for input.
 */
export function contextSettingsFor(config: VaraConfig, modelId: string): ContextSettings {
  const name = activeProviderName(config)
  const m = config.providers[name]?.models[modelId]
  const windowTokens = m?.contextWindow ?? config.context.windowTokens
  const window = windowTokens ?? contextWindowFromPattern(modelId) ?? 64_000
  const reserve = m?.maxOutputTokens ?? Math.min(config.context.maxOutputTokens, Math.max(256, Math.floor(window / 4)))
  return {
    ...(windowTokens ? { windowTokens, windowOrigin: m?.contextSource === 'discovered' ? ('detected' as const) : ('configured' as const) } : {}),
    maxOutputTokens: reserve,
    autoCompact: config.context.autoCompact,
    autoCompactAt: config.context.autoCompactAt,
  }
}

/** What this model can do about thinking, and the level in force (the user's choice or the default). */
export function thinkingFor(config: VaraConfig, modelId: string, providerName = activeProviderName(config)): { support: ThinkSupport | null; level: ThinkLevel | undefined } {
  const entry = config.providers[providerName]
  const m = entry?.models[modelId]
  const support = thinkingSupport({
    type: entry?.type ?? config.provider.id,
    baseUrl: entry?.baseUrl ?? config.provider.baseUrl,
    model: modelId,
    ...(m?.reasoning !== undefined ? { reasoningHint: m.reasoning } : {}),
  })
  return { support, level: effectiveLevel(support, m?.thinking) }
}

/** Does this model of the provider accept images? */
export function visionFor(config: VaraConfig, modelId: string, providerName = activeProviderName(config)): boolean {
  const entry = config.providers[providerName]
  const m = entry?.models[modelId]
  return visionSupport({
    type: entry?.type ?? config.provider.id,
    baseUrl: entry?.baseUrl ?? config.provider.baseUrl,
    model: modelId,
    ...(m?.vision !== undefined ? { visionHint: m.vision } : {}),
  })
}

/** Store a thinking level for a model of a provider. */
export function setModelThinking(config: VaraConfig, name: string, modelId: string, level: ThinkLevel): VaraConfig {
  return withProvider(config, name, (p) => ({
    ...p,
    models: { ...p.models, [modelId]: { ...(p.models[modelId] ?? { status: 'unknown' as const }), thinking: level } },
  }))
}
