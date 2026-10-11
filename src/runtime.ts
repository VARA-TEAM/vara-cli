import type { VaraConfig } from './config/config.js'
import { createProvider, type Provider, type ProviderConfig } from './llm/provider.js'
import { getSecretsForScope } from './security/vault.js'
import { registerSecret, scrubAll } from './security/redact.js'
import { assertConfigRef } from './config/refs.js'

/**
 * Wires configuration to a live provider.
 * The API key comes from the vault (preferred) or an env var; it is registered
 * with the redactor so it can never appear in transcripts, logs or the TUI.
 */
export async function buildProvider(config: VaraConfig, scope = 'global'): Promise<{ provider: Provider; config: ProviderConfig }> {
  // These fields hold NAMES (a secret name, an env var name) — never a key
  // value. Guard before use: a pasted key here would otherwise be used as a
  // lookup name and printed verbatim in the error below.
  assertConfigRef('provider.apiKeySecret', config.provider.apiKeySecret)
  assertConfigRef('provider.apiKeyEnv', config.provider.apiKeyEnv)

  let apiKey = ''

  if (config.provider.apiKeySecret) {
    const secrets = await getSecretsForScope(scope)
    apiKey = secrets[config.provider.apiKeySecret] ?? ''
    if (apiKey) registerSecret(apiKey, config.provider.apiKeySecret)
  }
  if (!apiKey && config.provider.apiKeyEnv) {
    apiKey = process.env[config.provider.apiKeyEnv] ?? ''
    if (apiKey) registerSecret(apiKey, config.provider.apiKeyEnv)
  }
  if (!apiKey) {
    // scrubAll as defense-in-depth: even if the guard above were bypassed, no
    // secret-shaped substring reaches the terminal or any log.
    throw new Error(
      scrubAll(
        `No API key found. Set one with: vara secret set ${config.provider.apiKeySecret} ` +
          `(or export ${config.provider.apiKeyEnv}).`,
      ),
    )
  }

  const providerConfig: ProviderConfig = {
    id: config.provider.id,
    baseUrl: config.provider.baseUrl || (config.provider.id === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.openai.com/v1'),
    apiKey,
    model: config.provider.model,
    ...(config.provider.maxTokens ? { maxTokens: config.provider.maxTokens } : {}),
  }
  return { provider: createProvider(providerConfig), config: providerConfig }
}
