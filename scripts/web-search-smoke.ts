/**
 * Manual check that web search really works from THIS machine (uses the real internet; never run in CI).
 *   npx tsx scripts/web-search-smoke.ts ["your query"]
 * Prints, per provider, whether it answered, how many results, and the first one. Then reads the first result page.
 */
import { WebSearchSchema } from '../src/config/config.js'
import { fetchPage } from '../src/web/chain.js'
import { duckduckgo, mojeek, searxng } from '../src/web/providers.js'

const query = process.argv[2] ?? 'node.js latest release'
const s = WebSearchSchema.parse({})
const providers = [duckduckgo(), mojeek(), ...(s.searxngInstances.length ? [searxng(s.searxngInstances)] : [])]
let first = ''
let working = 0
for (const p of providers) {
  const t = Date.now()
  try {
    const r = await p.search({ query, max: 5 })
    working += r.length ? 1 : 0
    console.log(`[${r.length ? 'OK  ' : 'EMPTY'}] ${p.id}: ${r.length} results in ${Date.now() - t} ms`)
    if (r[0]) {
      console.log(`        1. ${r[0].title}\n           ${r[0].url}\n           ${r[0].snippet.slice(0, 120)}`)
      first ||= r[0].url
    }
  } catch (e) {
    console.log(`[FAIL] ${p.id}: ${(e as Error).message}`)
  }
}
if (first) {
  try {
    const page = await fetchPage(first, { maxChars: 600 })
    console.log(`\nweb_fetch ${page.url}\n  title: ${page.title}\n  ${page.total} chars of text; first 200: ${page.text.slice(0, 200).replace(/\s+/g, ' ')}`)
  } catch (e) {
    console.log(`\nweb_fetch failed: ${(e as Error).message}`)
  }
}
console.log(`\n${working} of ${providers.length} keyless providers returned results from this machine.`)
process.exit(working ? 0 : 1)
