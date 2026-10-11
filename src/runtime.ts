import type { VaraConfig } from './config/config.js'
import { createProvider, type Provider, type ProviderConfig } from './llm/provider.js'
import { getSecretsForScope } from './security/vault.js'
import { registerSecret } from './security/redact.js'

/**
 * Wires configuration to a live provider.
 * The API key comes from the vault (preferred) or an env var; it is registered
 * with the redactor so it can never appear in transcripts, logs or the TUI.
 */
export async function buildProvider(config: VaraConfig, scope = 'global'): Promise<{ provider: Provider; config: ProviderConfig }> {
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
    throw new Error(
      `No API key found. Set one with: vara secret set ${config.provider.apiKeySecret} ` +
        `(or export ${config.provider.apiKeyEnv}).`,
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
