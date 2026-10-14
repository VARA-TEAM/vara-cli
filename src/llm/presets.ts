/**
 * Built-in provider presets: a name, the wire protocol, the endpoint and the
 * conventional env var — so adding one is "paste your key", nothing else.
 * Model lists are fetched from the provider itself; `suggestedModels` only
 * seeds a usable default before the first fetch.
 */
export interface ProviderPreset {
  name: string
  label: string
  type: 'openai' | 'anthropic'
  baseUrl: string
  apiKeyEnv: string
  keyless?: boolean
  flavor?: 'ollama'
  suggestedModels: string[]
  /** Where to get a key / what to run. */
  note: string
}

export const PRESETS: ProviderPreset[] = [
  { name: 'openai', label: 'OpenAI', type: 'openai', baseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', suggestedModels: ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1'], note: 'platform.openai.com/api-keys' },
  { name: 'anthropic', label: 'Anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKeyEnv: 'ANTHROPIC_API_KEY', suggestedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5'], note: 'console.anthropic.com/settings/keys' },
  { name: 'openrouter', label: 'OpenRouter', type: 'openai', baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', suggestedModels: [], note: 'openrouter.ai/keys — hundreds of models, one key' },
  { name: 'deepseek', label: 'DeepSeek', type: 'openai', baseUrl: 'https://api.deepseek.com/v1', apiKeyEnv: 'DEEPSEEK_API_KEY', suggestedModels: ['deepseek-chat', 'deepseek-reasoner'], note: 'platform.deepseek.com/api_keys' },
  { name: 'groq', label: 'Groq', type: 'openai', baseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', suggestedModels: ['llama-3.3-70b-versatile'], note: 'console.groq.com/keys' },
  { name: 'gemini', label: 'Google Gemini', type: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKeyEnv: 'GEMINI_API_KEY', suggestedModels: ['gemini-2.5-flash', 'gemini-2.5-pro'], note: 'aistudio.google.com/apikey' },
  { name: 'mistral', label: 'Mistral', type: 'openai', baseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', suggestedModels: ['mistral-large-latest'], note: 'console.mistral.ai/api-keys' },
  { name: 'xai', label: 'xAI', type: 'openai', baseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', suggestedModels: [], note: 'console.x.ai' },
  { name: 'together', label: 'Together AI', type: 'openai', baseUrl: 'https://api.together.xyz/v1', apiKeyEnv: 'TOGETHER_API_KEY', suggestedModels: [], note: 'api.together.ai/settings/api-keys' },
  { name: 'ollama', label: 'Ollama (local)', type: 'openai', baseUrl: 'http://localhost:11434/v1', apiKeyEnv: '', keyless: true, flavor: 'ollama', suggestedModels: [], note: 'no key — start `ollama serve`' },
  { name: 'lmstudio', label: 'LM Studio (local)', type: 'openai', baseUrl: 'http://localhost:1234/v1', apiKeyEnv: '', keyless: true, suggestedModels: [], note: 'no key — start the LM Studio server' },
]

export function findPreset(name: string): ProviderPreset | undefined {
  return PRESETS.find((p) => p.name === name)
}
