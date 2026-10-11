/**
 * Live end-to-end flow check against the REAL provider (KTAI): create a
 * session in a throwaway cwd, run the real engine with the REAL tools, and
 * print every meaningful event — tool calls, verification evidence, the
 * final report and the cost truth. This is what "sending a task" actually is.
 *
 * Requires KTAI_API_KEY in the environment. Writes only to (an isolated)
 * VARA_HOME and the throwaway cwd — run it with VARA_HOME pointed at a
 * disposable directory:
 *   $env:VARA_HOME="C:\temp\vara-live-home"; npx tsx scripts\live-flow-check.ts
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { buildProvider } from '../src/runtime.js'
import { ensureStore } from '../src/core/store.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { Engine } from '../src/core/engine.js'
import type { EngineEvent } from '../src/core/types.js'

// The user's real provider setup, kept small so a live run stays cheap.
const config: VaraConfig = {
  ...DEFAULT_CONFIG,
  provider: {
    id: 'openai',
    baseUrl: 'https://ktai.koyeb.app/v1',
    apiKeySecret: 'KTAI_API_KEY',
    apiKeyEnv: 'KTAI_API_KEY',
    model: 'deepseek-ai/deepseek-v4.1-flash',
  },
  budgets: { task: { maxTurns: 12, maxDurationMs: 10 * 60_000, maxModelCalls: 12 }, goal: DEFAULT_CONFIG.budgets.goal },
}

await ensureStore()
const { provider, config: pc } = await buildProvider(config)
console.error(`provider=${pc.id} baseUrl=${pc.baseUrl} model=${pc.model}`)

const cwd = mkdtempSync(join(tmpdir(), 'vara-live-'))
// Verification must MEAN something: the claim is only accepted if proof.txt
// really contains OK.
writeFileSync(
  join(cwd, 'verify.js'),
  "const fs=require('node:fs');process.exit(fs.readFileSync('proof.txt','utf8').trim()==='OK'?0:1)\n",
)

const parsed = CreateSessionInput.parse({
  kind: 'task',
  mode: 'build',
  objective:
    'Create a file named proof.txt in the working directory containing exactly the single word OK. Then call the complete tool with verifiedRequirements ["1"].',
  cwd,
  verifyCommand: 'node verify.js',
  model: pc.model,
})
const session = createSession(parsed, config)
console.error(`session=${session.id} cwd=${cwd}`)

const engine = new Engine({
  session,
  provider,
  model: pc.model,
  onEvent: (e: EngineEvent) => {
    if (e.type === 'tool_start') console.error(`[tool] ${e.name}`)
    else if (e.type === 'tool_end') {
      console.error(`[tool_end] ${e.name} ok=${e.ok} :: ${String(e.output ?? '').slice(0, 160).replace(/\s+/g, ' ')}`)
    } else if (e.type === 'state') console.error(`[state] ${e.state}`)
  },
})

await engine.run()
console.error('---- FINAL ----')
console.error('state:', session.state, session.stateReason ?? '')
console.error('active requirements:', (session.activeRequirements ?? []).join(' | ') || '(none recorded)')
console.error('evidence:', session.evidence.length, 'entries')
for (const ev of session.evidence.slice(0, 8)) {
  const detail = ev.command ?? ev.output ?? (ev.files ?? []).join(', ')
  console.error(`  - ${ev.kind} ok=${ev.ok}${ev.exitCode !== undefined ? ` exit=${ev.exitCode}` : ''} ${detail}`.slice(0, 160))
}
console.error('usage:', JSON.stringify(session.usage))
process.exit(0)
