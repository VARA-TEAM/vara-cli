import type { VaraConfig } from './config/config.js'
import { createProvider, type Provider, type ProviderConfig } from './llm/provider.js'
import { getSecretsForScope } from './security/vault.js'
import { registerSecret, scrubAll } from './security/redact.js'
import { assertConfigRef, configRef } from './config/refs.js'

/**
 * Wires configuration to a live provider.
 * The API key comes from the vault (preferred) or an env var; it is registered
 * with the redactor so it can never appear in transcripts, logs or the TUI.
 */
export interface KeyFields {
  apiKeySecret: string
  apiKeyEnv: string
  keyless?: boolean
}

/**
 * Resolve the API key for a provider: vault first, then env var. Keyless
 * providers (local servers) resolve to ''. Throws a message that names the
 * secret/variable to set — never a key value.
 */
export async function resolveApiKey(fields: KeyFields, scope = 'global'): Promise<string> {
  // These fields hold NAMES (a secret name, an env var name) — never a key
  // value. Guard before use: a pasted key here would otherwise be used as a
  // lookup name and printed verbatim in the error below.
  assertConfigRef('provider.apiKeySecret', fields.apiKeySecret)
  assertConfigRef('provider.apiKeyEnv', fields.apiKeyEnv)

  let apiKey = ''
  if (fields.apiKeySecret) {
    const secrets = await getSecretsForScope(scope)
    apiKey = secrets[fields.apiKeySecret] ?? ''
    if (apiKey) registerSecret(apiKey, fields.apiKeySecret)
  }
  if (!apiKey && fields.apiKeyEnv) {
    apiKey = process.env[fields.apiKeyEnv] ?? ''
    if (apiKey) registerSecret(apiKey, fields.apiKeyEnv)
  }
  if (!apiKey && !fields.keyless) {
    // scrubAll as defense-in-depth: even if the guard above were bypassed, no
    // secret-shaped substring reaches the terminal or any log.
    throw new Error(
      scrubAll(
        `No API key found. Set one with: vara secret set ${fields.apiKeySecret} ` +
          `(or export ${fields.apiKeyEnv}).`,
      ),
    )
  }
  return apiKey
}

/** Where a provider's key currently comes from — for status display only. */
export async function keySource(fields: KeyFields, scope = 'global'): Promise<'vault' | 'env' | 'none' | 'not needed'> {
  if (fields.keyless) return 'not needed'
  try {
    if (fields.apiKeySecret && configRef(fields.apiKeySecret)) {
      const secrets = await getSecretsForScope(scope)
      if (secrets[fields.apiKeySecret]) return 'vault'
    }
  } catch {
    /* an unreadable vault must not break the listing */
  }
  if (fields.apiKeyEnv && configRef(fields.apiKeyEnv) && process.env[fields.apiKeyEnv]) return 'env'
  return 'none'
}

export async function buildProvider(config: VaraConfig, scope = 'global'): Promise<{ provider: Provider; config: ProviderConfig }> {
  const apiKey = await resolveApiKey(config.provider, scope)

  const providerConfig: ProviderConfig = {
    id: config.provider.id,
    baseUrl: config.provider.baseUrl || (config.provider.id === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
    apiKey,
    model: config.provider.model,
    ...(config.provider.maxTokens ? { maxTokens: config.provider.maxTokens } : {}),
  }
  return { provider: createProvider(providerConfig), config: providerConfig }
}
