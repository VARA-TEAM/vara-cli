/**
 * Offline cost benchmark. Usage:  npx tsx scripts/cost-bench.ts [--json]
 *
 * Every number comes from scripted scenarios run through the real engine with a
 * measuring fake provider (tests/bench/scenarios.ts). It measures what VARA
 * SENDS, not what a model would do. See docs/COST.md for the method and limits.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Keep the benchmark away from the real ~/.vara.
process.env['VARA_HOME'] = mkdtempSync(join(tmpdir(), 'vara-bench-home-'))

const { ARMS, runWorkArm, runLoopScenario, runVerifyScenario, runChatScenario, runNavigationScenario, simulateLookback } = await import('../tests/bench/scenarios.js')

const json = process.argv.includes('--json')
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))
const pct = (n: number | null) => (n === null ? 'unknown' : `${n.toFixed(1)}%`)
const usd = (n: number | null) => (n === null ? 'unknown' : `$${n.toFixed(3)}`)
const NL = '\n'

const SIZES = [
  { label: 'medium session (about 33 model calls)', fillers: 22 },
  { label: 'long session (about 90 model calls)', fillers: 80 },
]
const sessions = []
for (const size of SIZES) {
  const results = []
  for (const arm of ARMS) results.push(await runWorkArm(arm, size.fillers))
  sessions.push({ ...size, results })
}
const loop = await runLoopScenario()
const verify = await runVerifyScenario()
const chat = await runChatScenario()
const nav = await runNavigationScenario(resolve(import.meta.dirname, '..'))
const lookback = [3, 10, 19, 22, 30].map((n) => simulateLookback(n))

if (json) {
  console.log(JSON.stringify({ sessions, loop, verify, chat, nav, lookback }, null, 2))
  process.exit(0)
}

let n = 0
for (const session of sessions) {
  n++
  const results = session.results
  const base = results[0]!
  console.log(`## 1.${n} A working ${session.label}: explore, read, edit, noisy tests, verify${NL}`)
  console.log('| arm | requests | input tokens | cache share | output | limit units* | USD | vs A (units) | vs A (USD) |')
  console.log('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |')
  for (const r of results) {
    const du = ((base.weightedTokens - r.weightedTokens) / base.weightedTokens) * 100
    const dd = base.usd !== null && r.usd !== null ? ((base.usd - r.usd) / base.usd) * 100 : null
    console.log(`| ${r.name} | ${r.requests} | ${k(r.totalInputTokens)} | ${(r.cacheShare * 100).toFixed(0)}% | ${k(r.outputTokens)} | ${k(r.weightedTokens)} | ${usd(r.usd)} | ${r === base ? '-' : pct(du)} | ${r === base ? '-' : pct(dd)} |`)
  }
  console.log(`${NL}*limit units = uncached input + 0.1 x cached input + output (cached weight 0.1, configurable).${NL}`)
  console.log(`Counters per arm (what the engine itself recorded):${NL}`)
  for (const r of results) {
    const s = r.savings
    console.log(
      `- ${r.name}: models ${JSON.stringify(r.byModel)}; compressed ${k(s.compressedChars ?? 0)} chars; identical-output pointers ${s.dedupedOutputs ?? 0}; read dedupes ${s.dedupedReads}; compaction ${k(s.compactedChars)} chars; summarised ${k(s.summarizedTokens ?? 0)} tokens; verification skipped ${s.skippedVerifications ?? 0}`,
    )
  }
  console.log(`${NL}The engine's own savings report (baseline = a plain loop with NO prompt cache; see the method) for arms B-E:${NL}`)
  for (const r of results.slice(1)) {
    console.log(`- ${r.name}: limit units saved ${pct(r.report.tokensSavedPercent)} (${k(r.report.actualTokens)} actual vs ${k(r.report.baselineTokens)} baseline); USD saved ${pct(r.report.usdSavedPercent)} over ${r.report.usdCoveredCalls}/${r.report.calls} priced calls`)
  }
  console.log('')
}

console.log(`## 2. Runaway loop (the same call forever, 80 scripted turns available)${NL}`)
console.log(`- v0.4.0: ${loop.requestsWithout} requests, ${k(loop.tokensWithout)} uncached input tokens (stopped only by the 60-turn budget)`)
console.log(`- v2 (stops after 5 identical calls): ${loop.requestsWith} requests, ${k(loop.tokensWith)} uncached input tokens`)

console.log(`${NL}## 3. Re-verification when nothing changed (3 completion claims in a row)${NL}`)
console.log(`- verification command runs: v0.4.0 ${verify.runsWithout}, v2 ${verify.runsWith}`)

console.log(`${NL}## 4. Chat and questions (10 messages, same replies)${NL}`)
console.log(
  `- all on the strong model: ${usd(chat.usdAllStrong)}; routed to the cheap tier: ${usd(chat.usdRouted)}${chat.usdAllStrong && chat.usdRouted !== null ? ` (${pct(((chat.usdAllStrong - chat.usdRouted) / chat.usdAllStrong) * 100)} less)` : ''}`,
)

console.log(`${NL}## 5. Finding code in this repository (${nav.files} source files indexed)${NL}`)
console.log(`- "where is saveSession and how is it used": exploring the usual way ~${k(nav.tokensExploring)} tokens; repo_map + read_symbol ~${k(nav.tokensWithMap)} tokens`)
console.log(`- the longest source file read without a range: ~${k(nav.longFileTokensFull)} tokens full vs ~${k(nav.longFileTokensOutline)} as outline + first lines`)

console.log(`${NL}## 6. Anthropic cache lookback (position-level simulation of the documented 20-position rule)${NL}`)
console.log('| positions one turn adds (a typical tool turn adds 3) | cached share, last-message breakpoint only | with the extra breakpoint |')
console.log('| ---: | ---: | ---: |')
for (const l of lookback) console.log(`| ${l.positionsPerTurn} | ${(l.cachedShareOld * 100).toFixed(0)}% | ${(l.cachedShareNew * 100).toFixed(0)}% |`)
