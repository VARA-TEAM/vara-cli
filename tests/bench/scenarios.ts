/**
 * Offline cost benchmark: scripted scenarios run through the REAL engine with a
 * measuring fake provider. Nothing here calls a model, so the numbers are
 * about what VARA SENDS, not about how a model would behave:
 *
 *   - the scripts are fixed (the same tool calls in every arm), so an arm that
 *     sends less is not "smarter", it is leaner for the same conversation;
 *   - where a technique needs the model to do something extra (ask for the rest
 *     of a compressed output), the script of that arm contains that extra turn,
 *     so its cost is counted;
 *   - the provider cache is SIMULATED (longest common prefix with the previous
 *     request to the same model, 1024-token minimum); real providers differ in
 *     details (TTL, block granularity), see docs/COST.md "What is measured";
 *   - prices come from src/llm/registry.ts as of the dates stored there.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../../src/llm/provider.js'
import type { NormalizedUsage } from '../../src/llm/usage.js'
import { DEFAULT_CONFIG } from '../../src/config/config.js'
import { DEFAULT_ROUTER, type RouterSettings } from '../../src/core/router.js'
import { UsageMeter, savingsReport, type SavingsReport } from '../../src/core/usage-meter.js'
import { buildIndex, invalidateRepoMap, renderMap, findSymbols } from '../../src/core/repomap.js'
import { readFileTool } from '../../src/tools/fs-tools.js'
import { readSymbolTool, repoMapTool } from '../../src/tools/repo-tools.js'
import { placeMessageBreakpoints, type AnthropicMessage } from '../../src/llm/cache.js'
import { estimateTokens } from '../../src/core/context.js'
import type { Session } from '../../src/core/types.js'

export const STRONG = 'claude-3-opus'
export const STANDARD = 'claude-3-5-sonnet'
export const CHEAP = 'claude-3-5-haiku'

/* ------------------------------------------------------------------ */
/* The measuring provider                                              */
/* ------------------------------------------------------------------ */

export interface RequestStat {
  model: string
  totalTokens: number
  cachedTokens: number
  outputTokens: number
  kind: 'work' | 'chat' | 'summary'
}

const MIN_CACHEABLE_CHARS = 4096

export class BenchProvider implements Provider {
  id = 'anthropic' as const
  stats: RequestStat[] = []
  private last = new Map<string, string[]>()
  private n = 0
  constructor(private readonly script: Array<AssistantTurn | ((req: ProviderRequest, n: number) => AssistantTurn)>, private readonly summaryText = 'GOAL fix the parser. DONE: read and edited files. OPEN: nothing.') {}

  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    const items = [req.system, JSON.stringify(req.tools), ...req.messages.map((m) => JSON.stringify(m))]
    const total = items.reduce((n, s) => n + s.length, 0)
    const prev = this.last.get(req.model)
    let prefix = 0
    if (prev) {
      for (let i = 0; i < Math.min(prev.length, items.length); i++) {
        if (prev[i] === items[i]) prefix += items[i]!.length
        else {
          const a = prev[i]!
          const b = items[i]!
          let k = 0
          while (k < a.length && k < b.length && a[k] === b[k]) k++
          prefix += k
          break
        }
      }
    }
    this.last.set(req.model, items)
    const cachedChars = prefix >= MIN_CACHEABLE_CHARS ? prefix : 0

    const isSummary = req.system.includes('compress the working history')
    let turn: AssistantTurn
    if (isSummary) turn = { content: this.summaryText, toolCalls: [] }
    else {
      const next = this.script.shift()
      turn = typeof next === 'function' ? next(req, this.n) : (next ?? { content: 'done', toolCalls: [] })
      this.n++
    }
    const outChars = turn.content.length + turn.toolCalls.reduce((n, c) => n + c.arguments.length + c.name.length + 20, 0)
    const stat: RequestStat = {
      model: req.model,
      totalTokens: Math.ceil(total / 4),
      cachedTokens: Math.floor(cachedChars / 4),
      outputTokens: Math.ceil(outChars / 4),
      kind: isSummary ? 'summary' : req.system.includes('# Session Type') ? 'work' : 'chat',
    }
    this.stats.push(stat)
    const usage: NormalizedUsage = {
      inputTokens: stat.totalTokens - stat.cachedTokens,
      outputTokens: stat.outputTokens,
      cachedInputTokens: stat.cachedTokens,
      cacheWriteTokens: null,
      reportedTotalInputTokens: stat.totalTokens,
      source: 'provider',
      complete: true,
    }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn, usage }
  }
}

/* ------------------------------------------------------------------ */
/* Scenario 1: a working session                                       */
/* ------------------------------------------------------------------ */

function genFile(prefix: string, functions: number, linesEach = 12): string {
  const out: string[] = [`// ${prefix} module`, `import { shared } from './shared'`, '']
  for (let f = 0; f < functions; f++) {
    out.push(`export function ${prefix}Handler${f}(input: string, options: { retries: number }): string {`)
    for (let l = 0; l < linesEach - 2; l++) out.push(`  const step${l} = shared(input, ${l}) // ${prefix} step ${f}.${l}: normalise, validate and record the value`)
    out.push(`  return input.trim()`, `}`, '')
  }
  return out.join('\n')
}

export async function makeWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vara-bench-'))
  await mkdir(join(dir, 'src'), { recursive: true })
  for (const n of ['a', 'b', 'c', 'd', 'e']) await writeFile(join(dir, 'src', `${n}.ts`), genFile(n, 18))
  await writeFile(join(dir, 'src', 'big.ts'), genFile('big', 115)) // ~1,600 lines
  await writeFile(join(dir, 'src', 'shared.ts'), 'export function shared(a: string, n: number): string {\n  return a + n\n}\n')
  return dir
}

/** The test command: 2,500 lines of noise, one failure near the end (or none). */
function testCommand(fail: boolean): string {
  return `node -e "for(let i=0;i<2500;i++)console.log(i===2300&&${fail}?'FAIL src/a.ts > aHandler3 returned wrong value (expected 4, got 3)':' ok src/'+'abcde'[i%5]+'.ts > case '+i+' (2ms)');console.log(${fail}?'Tests 1 failed | 2499 passed':'Tests 2500 passed')"`
}

const tc = (id: string, name: string, args: unknown): AssistantTurn['toolCalls'][number] => ({ id, name, arguments: JSON.stringify(args) })
const turn = (...calls: AssistantTurn['toolCalls']): AssistantTurn => ({ content: '', toolCalls: calls })

/** The fixed script of the working session. `askForMore` picks how the failure is found. */
export function workScript(mode: 'plain' | 'v2', fillers = 22): Array<AssistantTurn | ((req: ProviderRequest, n: number) => AssistantTurn)> {
  const s: AssistantTurn[] = []
  s.push(turn(tc('t1a', 'list_dir', { path: 'src' }), tc('t1b', 'grep', { pattern: 'Handler3', path: 'src' })))
  s.push(turn(tc('t2a', 'read_file', { path: 'src/a.ts' }), tc('t2b', 'read_file', { path: 'src/b.ts' })))
  s.push(turn(tc('t3', 'read_file', { path: 'src/big.ts' })))
  s.push(turn(tc('t4', 'read_file', { path: 'src/big.ts', offset: 700, limit: 80 })))
  s.push(turn(tc('t5', 'shell', { command: testCommand(true) })))
  // How the model finds the failure the output did not show:
  if (mode === 'v2') s.push(turn(tc('t6', 'tool_output', { id: 't5', grep: 'FAIL' })))
  else s.push(turn(tc('t6', 'shell', { command: testCommand(true) + ' | findstr FAIL' })))
  s.push(turn(tc('t7', 'write_file', { path: 'src/a.ts', content: genFile('a', 18).replace('return input.trim()', 'return input.trim().toLowerCase()') })))
  s.push(turn(tc('t8', 'shell', { command: testCommand(false) })))
  s.push(turn(tc('t9', 'list_dir', { path: 'src' })))
  s.push(turn(tc('t10', 'list_dir', { path: 'src' })))
  const files = ['a', 'b', 'c', 'd', 'e']
  for (let i = 0; i < fillers; i++) {
    const id = `f${i}`
    if (i % 4 === 0) s.push(turn(tc(id, 'read_file', { path: `src/${files[i % 5]}.ts` })))
    else if (i % 4 === 1) s.push(turn(tc(id, 'grep', { pattern: `Handler${i}`, path: 'src' })))
    else if (i % 4 === 2) s.push(turn(tc(id, 'read_file', { path: 'src/big.ts', offset: 100 + i * 40, limit: 60 })))
    else s.push(turn(tc(id, 'grep', { pattern: `step${i % 9}`, path: 'src' })))
  }
  s.push(turn(tc('done', 'complete', { summary: 'fixed aHandler3', verificationPlan: 'ran the tests', verifiedRequirements: ['1'] })))
  return s
}

export interface Arm {
  name: string
  description: string
  /** Engine options for this arm. */
  options: (meter: UsageMeter) => Record<string, unknown>
  scriptMode: 'plain' | 'v2'
}

const routerWith = (tiers: RouterSettings['tiers'], floor: RouterSettings['floor'] = 'standard') => (): RouterSettings => ({ ...DEFAULT_ROUTER, tiers, floor })
const COST_ON = { summarize: true, toolOutputChars: 3000, smartRead: true }

export const ARMS: Arm[] = [
  { name: 'A  v0.4.0', description: 'everything that existed before: stable prefix, cache_control, compaction, read dedupe', options: () => ({}), scriptMode: 'plain' },
  {
    name: 'B  + output economics',
    description: 'A + relevance compression of long output (with tool_output), identical-output pointers, outline for long files, verification reuse, loop stop',
    options: (meter) => ({ meter, costSettings: () => ({ ...COST_ON, summarize: false }) }),
    scriptMode: 'v2',
  },
  {
    name: 'C  + summaries (cheap tier)',
    description: 'B + old turns folded once into a cheap-model summary',
    options: (meter) => ({ meter, router: routerWith({ cheap: { model: CHEAP } }), costSettings: () => COST_ON }),
    scriptMode: 'v2',
  },
  {
    name: 'D  + router (standard tier)',
    description: 'C + work turns on the standard tier, strong only for planning-hard / escalation (floor standard)',
    options: (meter) => ({ meter, router: routerWith({ cheap: { model: CHEAP }, standard: { model: STANDARD } }), costSettings: () => COST_ON }),
    scriptMode: 'v2',
  },
  {
    name: 'E  + floor lowered to cheap',
    description: 'D with the quality floor set to cheap: mechanical turns after read/search results go to the cheap tier (after the 2-turn hysteresis)',
    options: (meter) => ({ meter, router: routerWith({ cheap: { model: CHEAP }, standard: { model: STANDARD } }, 'cheap'), costSettings: () => COST_ON }),
    scriptMode: 'v2',
  },
]

export interface ArmResult {
  name: string
  description: string
  requests: number
  turns: number
  totalInputTokens: number
  cachedTokens: number
  outputTokens: number
  usd: number | null
  usdPartial: boolean
  /** Share of input tokens served from the (simulated) cache. */
  cacheShare: number
  /** What the limit counts: input + 0.1 * cached + output. */
  weightedTokens: number
  byModel: Record<string, number>
  report: SavingsReport
  savings: NonNullable<Session['savings']>
  state: string
}

export async function runWorkArm(arm: Arm, fillers = 22): Promise<ArmResult> {
  const [{ Engine }, { createSession, CreateSessionInput }] = await Promise.all([import('../../src/core/engine.js'), import('../../src/core/session.js')])
  const dir = await makeWorkspace()
  const metaDir = await mkdtemp(join(tmpdir(), 'vara-bench-meter-'))
  try {
    const session = createSession(CreateSessionInput.parse({ objective: 'Fix the failing test in src/a.ts (aHandler3 returns the wrong value) and prove it with the tests', cwd: dir, kind: 'task', model: STRONG, verifyCommand: 'node -e "process.exit(0)"' }), DEFAULT_CONFIG)
    session.config.budget = { maxTurns: 200, maxDurationMs: 3_600_000, maxModelCalls: 500 }
    const meter = new UsageMeter(join(metaDir, 'usage.jsonl'))
    const provider = new BenchProvider(workScript(arm.scriptMode, fillers))
    await new Engine({ session, provider, model: STRONG, ...arm.options(meter) }).run()
    await meter.flush()
    const st = provider.stats
    const total = st.reduce((n, r) => n + r.totalTokens, 0)
    const cached = st.reduce((n, r) => n + r.cachedTokens, 0)
    const out = st.reduce((n, r) => n + r.outputTokens, 0)
    const byModel: Record<string, number> = {}
    for (const r of st) byModel[r.model] = (byModel[r.model] ?? 0) + 1
    return {
      name: arm.name,
      description: arm.description,
      requests: st.length,
      turns: session.usage.turns,
      totalInputTokens: total,
      cachedTokens: cached,
      outputTokens: out,
      usd: session.usage.costUsd,
      usdPartial: session.usage.costPartial,
      cacheShare: total ? cached / total : 0,
      weightedTokens: total - cached + cached * 0.1 + out,
      byModel,
      report: arm.name.startsWith('A') ? savingsReport([]) : meter.report({ sid: session.id }, 0.1),
      savings: session.savings ?? { compactedChars: 0, dedupedReads: 0, cheapCalls: 0, subagents: 0 },
      state: session.state,
    }
  } finally {
    invalidateRepoMap()
    await rm(dir, { recursive: true, force: true })
    await rm(metaDir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */
/* Scenario 2: a runaway loop                                          */
/* ------------------------------------------------------------------ */

export interface LoopResult {
  requestsWithout: number
  requestsWith: number
  tokensWithout: number
  tokensWith: number
}

export async function runLoopScenario(): Promise<LoopResult> {
  const [{ Engine }, { createSession, CreateSessionInput }] = await Promise.all([import('../../src/core/engine.js'), import('../../src/core/session.js')])
  const dir = await makeWorkspace()
  const run = async (costSettings: boolean) => {
    const session = createSession(CreateSessionInput.parse({ objective: 'Look at the src folder', cwd: dir, kind: 'task', model: STRONG }), DEFAULT_CONFIG)
    // The same call forever (what a stuck model does).
    const provider = new BenchProvider(Array.from({ length: 80 }, (_, i) => turn(tc(`loop${i}`, 'list_dir', { path: 'src' }))))
    await new Engine({ session, provider, model: STRONG, ...(costSettings ? { costSettings: () => COST_ON } : {}) }).run()
    return { requests: provider.stats.length, tokens: provider.stats.reduce((n, r) => n + r.totalTokens - r.cachedTokens, 0) }
  }
  try {
    const a = await run(false)
    const b = await run(true)
    return { requestsWithout: a.requests, requestsWith: b.requests, tokensWithout: a.tokens, tokensWith: b.tokens }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */
/* Scenario 3: verification reuse                                      */
/* ------------------------------------------------------------------ */

export async function runVerifyScenario(): Promise<{ runsWithout: number; runsWith: number }> {
  const [{ Engine }, { createSession, CreateSessionInput }] = await Promise.all([import('../../src/core/engine.js'), import('../../src/core/session.js')])
  const dir = await makeWorkspace()
  const marker = join(dir, 'runs.txt')
  await writeFile(marker, '')
  const cmd = `node -e "require('fs').appendFileSync(process.argv[1],'x');process.exit(1)" "${marker.replace(/\\/g, '/')}"`
  const run = async (costSettings: boolean) => {
    await writeFile(marker, '')
    const session = createSession(CreateSessionInput.parse({ objective: 'make the build pass', cwd: dir, kind: 'task', model: STRONG, verifyCommand: cmd }), DEFAULT_CONFIG)
    const claim = (id: string) => turn(tc(id, 'complete', { summary: 'done', verificationPlan: 'ran', verifiedRequirements: ['1'] }))
    const provider = new BenchProvider([claim('c1'), claim('c2'), claim('c3')])
    await new Engine({ session, provider, model: STRONG, ...(costSettings ? { costSettings: () => COST_ON } : {}) }).run()
    return (await readFile(marker, 'utf8')).length
  }
  try {
    return { runsWithout: await run(false), runsWith: await run(true) }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */
/* Scenario 4: Anthropic cache lookback (model-based simulation)      */
/* ------------------------------------------------------------------ */

export interface LookbackResult {
  /** Separate cache positions one turn adds (consecutive tool_use / tool_result blocks count as ONE position each). */
  positionsPerTurn: number
  cachedShareOld: number
  cachedShareNew: number
}

/**
 * Position-level model of Anthropic's documented rule: cache entries are written
 * only at breakpoints; on a read each breakpoint looks back at most 20 positions
 * for an entry an earlier request wrote (consecutive tool_use blocks, or
 * consecutive tool_result blocks, count as one position). A typical agent turn
 * (text + tool_use group + tool_result group) adds 3 positions, so the second
 * breakpoint changes nothing there; it only matters when one turn adds 20+
 * positions (for example many separate image/text blocks in one message).
 * A SIMULATION of the documented behaviour, not a measurement of the live API.
 */
export function simulateLookback(positionsPerTurn: number, turns = 25, tokensPerPosition = 300, lookback = 20): LookbackResult {
  const run = (usePrevious: boolean): number => {
    let positions = 1 // the objective
    const written = new Set<number>()
    let cached = 0
    let total = 0
    for (let t = 0; t < turns; t++) {
      const bps = [positions]
      // end of the previous user message = where the last request's breakpoint was
      if (usePrevious && positions - positionsPerTurn >= 1) bps.push(positions - positionsPerTurn)
      let best = 0
      for (const bp of bps) {
        for (let p = bp; p >= Math.max(1, bp - lookback + 1); p--) {
          if (written.has(p)) {
            best = Math.max(best, p)
            break
          }
        }
      }
      cached += best * tokensPerPosition
      total += positions * tokensPerPosition
      for (const bp of bps) written.add(bp)
      positions += positionsPerTurn
    }
    return total ? cached / total : 0
  }
  return { positionsPerTurn, cachedShareOld: run(false), cachedShareNew: run(true) }
}

/** The breakpoint placement is exercised for real as well: how many blocks carry cache_control. */
export function countBreakpoints(): number {
  const msgs: AnthropicMessage[] = [
    { role: 'user', content: 'objective' },
    { role: 'assistant', content: [{ type: 'tool_use' }] },
    { role: 'user', content: [{ type: 'tool_result' }] },
    { role: 'assistant', content: [{ type: 'tool_use' }] },
    { role: 'user', content: [{ type: 'tool_result' }] },
  ]
  return placeMessageBreakpoints(msgs)
}

/* ------------------------------------------------------------------ */
/* Scenario 5: chat and questions                                      */
/* ------------------------------------------------------------------ */

export interface ChatResult {
  usdAllStrong: number | null
  usdRouted: number | null
  requests: number
}

export async function runChatScenario(): Promise<ChatResult> {
  const [{ Engine }, { createSession, CreateSessionInput }] = await Promise.all([import('../../src/core/engine.js'), import('../../src/core/session.js')])
  const dir = await makeWorkspace()
  const messages = ['hello', 'thanks', 'how are you', 'what can you do', 'what is a closure in javascript', 'why is the sky blue', 'good morning', 'who are you', 'how does git rebase work', 'ok great']
  const run = async (routed: boolean) => {
    let usd: number | null = 0
    let requests = 0
    for (const m of messages) {
      const session = createSession(CreateSessionInput.parse({ objective: m, cwd: dir, kind: 'task', model: STRONG, auto: true }), DEFAULT_CONFIG)
      const provider = new BenchProvider([{ content: 'Sure - here is a short answer that is a couple of sentences long, enough to be a normal reply.', toolCalls: [] }])
      await new Engine({ session, provider, model: STRONG, ...(routed ? { router: routerWith({ cheap: { model: CHEAP } }) } : {}) }).run()
      requests += provider.stats.length
      usd = usd !== null && session.usage.costUsd !== null ? usd + session.usage.costUsd : null
    }
    return { usd, requests }
  }
  try {
    const a = await run(false)
    const b = await run(true)
    return { usdAllStrong: a.usd, usdRouted: b.usd, requests: a.requests }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/* ------------------------------------------------------------------ */
/* Scenario 6: finding code - repo map vs reading                      */
/* ------------------------------------------------------------------ */

export interface NavResult {
  files: number
  /** Tokens to answer "where is saveSession and how is it used" by exploring the usual way. */
  tokensExploring: number
  tokensWithMap: number
  longFileTokensFull: number
  longFileTokensOutline: number
}

/** Runs against the real source tree of this repository. */
export async function runNavigationScenario(repoRoot: string): Promise<NavResult> {
  invalidateRepoMap()
  const idx = await buildIndex(repoRoot, true)
  const ctx = { cwd: repoRoot, mode: 'build' as const, sessionId: 'bench', scope: 'session:bench', env: {}, allowPublish: false }
  // The usual way: list the tree, grep the name, read every file that mentions it in full (capped at 12 000 chars like the engine).
  const cap = (s: string) => Math.min(s.length, 12_000)
  const mentions = idx.files.filter((f) => f.words.has('saveSession')).slice(0, 4)
  let exploring = 0
  exploring += estimateTokens('x'.repeat(2_500)) // list_dir of src (typical size)
  exploring += estimateTokens('x'.repeat(1_800)) // grep matches
  for (const f of mentions) exploring += Math.ceil(cap(await readFile(join(repoRoot, f.path), 'utf8')) / 4)
  // With the map: one ranked outline + the one symbol.
  const map = await repoMapTool.execute({ query: 'save session store' }, ctx)
  const sym = await readSymbolTool.execute({ name: 'saveSession' }, ctx)
  const withMap = estimateTokens(map.output) + estimateTokens(sym.output)
  // A long file read without a range.
  const long = idx.files.slice().sort((a, b) => b.lines - a.lines)[0]!
  const full = await readFile(join(repoRoot, long.path), 'utf8')
  const outline = await readFileTool.execute({ path: long.path }, ctx)
  invalidateRepoMap()
  void renderMap
  void findSymbols
  return {
    files: idx.files.length,
    tokensExploring: exploring,
    tokensWithMap: withMap,
    longFileTokensFull: Math.ceil(cap(full) / 4),
    longFileTokensOutline: estimateTokens(outline.output),
  }
}
