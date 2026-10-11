/**
 * Live usage verification (throwaway): one tiny streaming call against the
 * configured provider, printing the NORMALIZED usage and computed cost.
 * Verifies the real endpoint's streaming-usage behavior — the one thing unit
 * tests with mocked SSE cannot prove.
 */
import { loadConfig } from '../src/config/config.js'
import { buildProvider } from '../src/runtime.js'
import { computeCost } from '../src/llm/cost.js'
import { findModel } from '../src/llm/registry.js'

const config = await loadConfig()
const { provider, config: pc } = await buildProvider(config)
console.log(`provider=${pc.id} baseUrl=${pc.baseUrl} model=${pc.model}`)

let sawDone = false
for await (const event of provider.chat({
  system: 'You are a connectivity check.',
  messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  tools: [],
  model: pc.model,
  maxTokens: 32,
})) {
  if (event.type === 'done') {
    sawDone = true
    console.log('usage:', JSON.stringify(event.usage))
    const spec = findModel(pc.model, pc.id)
    console.log('registry entry:', spec ? `${spec.id} (priced: ${Boolean(spec.pricing)})` : 'NONE — pricing unknown (expected for this model)')
    const cost = computeCost(event.usage, null, pc.model, pc.id)
    console.log('cost:', JSON.stringify(cost))
  } else if (event.type === 'error') {
    console.log('error event:', event.message.slice(0, 300))
  }
}
console.log(sawDone ? 'DONE event received' : 'NO done event')
