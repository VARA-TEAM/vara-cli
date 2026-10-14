/**
 * Development host for the web interface: a real VaraHost + HTTP server with a scripted
 * "model", so the UI can be built and checked without an API key or any cost.
 *
 *   npm run dev:ui          → prints the owner link; open it in a browser
 *
 * The fake model streams markdown (headings, lists, code, a table), calls real tools in a
 * temporary folder, and answers greetings like a chat. Everything else is the real thing.
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'

// The data folder must be chosen BEFORE any VARA module loads (paths are fixed at import time),
// so a dev run can never touch the real ~/.vara. Hence the dynamic imports below.
const work = mkdtempSync(join(tmpdir(), 'vara-dev-'))
writeFileSync(join(work, 'README.md'), '# demo project\n\nA tiny folder the fake agent can read and edit.\n')
process.env['VARA_HOME'] = join(work, '.vara-home')
const { DEFAULT_CONFIG } = await import('../src/config/config.js')
const { ensureProviders } = await import('../src/config/providers.js')
const { McpHub } = await import('../src/mcp/hub.js')
const { ensureStore } = await import('../src/core/store.js')
const { AccessStore, presetGrant } = await import('../src/server/access.js')
const { VaraHost } = await import('../src/server/host.js')
const { newOwnerToken, startServer } = await import('../src/server/http.js')

const LONG = `## How this project is organised

The folder holds a **small demo**. Here is what I found:

- \`README.md\` — the introduction
- \`src/\` — *(not created yet)*
- tests — none

### A quick check

| File | Lines | Status |
| :-- | --: | :-: |
| README.md | 3 | ok |
| notes.txt | 1 | new |

\`\`\`ts
export function greet(name: string): string {
  return \`hello, \${name}\`
}
\`\`\`

> Tip: ask me to *create* a file and I will verify it before I say I am done.

أستطيع أيضاً الرد بالعربية: هذه **فقرة عربية** للتأكد من أن الاتجاه صحيح.`

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

class FakeProvider implements Provider {
  id = 'openai' as const
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const last = req.messages.filter((m) => !m.content.startsWith('[STATE]')).at(-1)
    const userText = [...req.messages].reverse().find((m) => m.role === 'user' && !m.content.startsWith('['))?.content.toLowerCase() ?? ''
    const say = async function* (text: string): AsyncIterable<ProviderEvent> {
      for (let i = 0; i < text.length; i += 14) {
        yield { type: 'text', delta: text.slice(i, i + 14) }
        await sleep(18)
      }
    }
    let turn: AssistantTurn
    if (last?.role === 'tool') {
      const name = req.messages.findLast?.((m) => m.role === 'assistant' && m.toolCalls?.length)?.toolCalls?.[0]?.name
      if (name === 'write_file') {
        yield* say('Created and checked the file. Marking the work as done.')
        turn = { content: 'Created and checked the file. Marking the work as done.', toolCalls: [{ id: `c${Date.now()}`, name: 'complete', arguments: JSON.stringify({ summary: 'Created notes.txt with the requested text', verificationPlan: 'read the file back', verifiedRequirements: ['1'] }) }] }
      } else {
        const text = 'Done — that is everything I needed.'
        yield* say(text)
        turn = { content: text, toolCalls: [] }
      }
    } else if (/^(hi|hello|hellp|hey|مرحبا|اهلا)/.test(userText) || userText.length < 6) {
      const text = 'Hi! I am **VARA**. I can explain the code, fix bugs, or keep watching something for you. What should we do?'
      yield* say(text)
      turn = { content: text, toolCalls: [] }
    } else if (/create|add|write|اكتب|انشئ/.test(userText)) {
      const text = "I'll create `notes.txt` now."
      yield* say(text)
      turn = { content: text, toolCalls: [{ id: `w${Date.now()}`, name: 'write_file', arguments: JSON.stringify({ path: 'notes.txt', content: 'hello from VARA\n' }) }] }
    } else {
      yield* say(LONG)
      turn = { content: LONG, toolCalls: [] }
    }
    yield { type: 'done', result: turn }
  }
}

await ensureStore()
const config = ensureProviders({ ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider, model: 'demo-model' } })
const access = new AccessStore(join(work, 'host'))
const host = new VaraHost({ config: () => config, provider: () => new FakeProvider(), hub: new McpHub(), access, cwd: work })
const ownerToken = process.env['VARA_DEV_TOKEN'] ?? newOwnerToken()
const server = await startServer({ host, ownerToken, port: Number(process.env['PORT'] ?? 7788), onError: (e) => console.error('[dev-host] error', e) })

const guest = access.createInvite(presetGrant('collaborator'), { label: 'demo', ttlMs: 3_600_000, maxUses: 5 })
console.log(`\nVARA dev host (fake model) — folder ${work}`)
console.log(`  owner : http://127.0.0.1:${server.port}/#token=${ownerToken}`)
console.log(`  guest : http://127.0.0.1:${server.port}/join/${guest.token}`)
process.on('SIGINT', () => void host.closeAll().then(() => process.exit(0)))
