/**
 * Makes the README screenshots from the REAL web interface, with a scripted local model (no provider, no key, no
 * network): it starts a throw-away project, a fake OpenAI-compatible server that plays one short fix-a-bug
 * conversation, `vara ui` pointed at it, and a real Chrome driven over the DevTools Protocol.
 *
 *   npm run build && npx tsx scripts/capture-screens.ts      → docs/img/*.png
 *
 * What the pictures show is real UI; what the "model" says is a script, and the README says so.
 */
import { execSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findBrowser, launchBrowser } from '../src/browser/chrome.js'
import { connectCdp } from '../src/browser/cdp.js'

const root = resolve(process.cwd())
const out = join(root, 'docs', 'img')
mkdirSync(out, { recursive: true })
const home = mkdtempSync(join(tmpdir(), 'vara-shots-home-'))
const project = mkdtempSync(join(tmpdir(), 'vara-shots-'))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A tiny project with one bug.
mkdirSync(join(project, 'src'), { recursive: true })
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'cart', scripts: { test: 'node --test' } }, null, 2))
writeFileSync(join(project, 'src', 'cart.js'), 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0) // forgets the quantity\n}\n')
writeFileSync(join(project, 'cart.test.js'), "import test from 'node:test'\nimport assert from 'node:assert'\nimport { total } from './src/cart.js'\ntest('total counts quantity', () => assert.equal(total([{ price: 5, qty: 2 }]), 10))\n")

execSync('git init -q && git add -A && git -c user.email=demo@example.com -c user.name=demo commit -q -m initial', { cwd: project })

// The scripted model: look, read, fix, report.
type Step = { text?: string; tool?: { name: string; args: unknown } }
const script: Step[] = [
  { text: 'I will look at the project first.', tool: { name: 'list_dir', args: { path: '.' } } },
  { tool: { name: 'read_file', args: { path: 'src/cart.js' } } },
  { text: 'Found it: total adds the price but ignores qty. Fixing it.', tool: { name: 'edit_file', args: { path: 'src/cart.js', oldString: 'sum + i.price', newString: 'sum + i.price * (i.qty ?? 1)' } } },
  { text: 'Now the tests.', tool: { name: 'shell', args: { command: 'node --test' } } },
  {
    tool: {
      name: 'complete',
      args: {
        summary: 'Fixed src/cart.js: total now multiplies each price by its quantity. One line changed.',
        verificationPlan: 'Ran node --test: the quantity test passes.',
        verifiedRequirements: ['1'],
        changedFiles: ['src/cart.js'],
      },
    },
  },
]
let turn = 0
const model = createServer((req, res) => {
  if (req.url?.endsWith('/models')) return void res.end(JSON.stringify({ data: [{ id: 'demo-model' }] }))
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    const wantsStream = (() => {
      try {
        return (JSON.parse(body) as { stream?: boolean }).stream === true
      } catch {
        return false
      }
    })()
    const step = script[Math.min(turn++, script.length - 1)]!
    const delta: Record<string, unknown> = {}
    if (step.text) delta['content'] = step.text
    if (step.tool) delta['tool_calls'] = [{ index: 0, id: `call_${turn}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }]
    const usage = { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 }
    if (!wantsStream) return void res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...delta }, finish_reason: step.tool ? 'tool_calls' : 'stop' }], usage }))
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: step.tool ? 'tool_calls' : 'stop' }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
})
await new Promise<void>((r) => model.listen(0, '127.0.0.1', r))
const modelPort = (model.address() as { port: number }).port

// VARA's config: one keyless provider that points at the scripted model.
writeFileSync(
  join(home, 'config.json'),
  JSON.stringify({
    provider: { id: 'openai', name: 'demo', keyless: true, baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'demo-model' },
    providers: { demo: { type: 'openai', label: 'Demo model', baseUrl: `http://127.0.0.1:${modelPort}/v1`, keyless: true, apiKeySecret: '', apiKeyEnv: '', models: { 'demo-model': { status: 'ok' } } } },
    updates: { check: false },
  }),
)

const port = 7791
const host = spawn(process.execPath, [join(root, 'dist', 'cli.js'), 'ui', '--local', '--port', String(port), '--cwd', project], { env: { ...process.env, VARA_HOME: home, BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'] })
let log = ''
host.stdout.on('data', (d) => (log += d))
host.stderr.on('data', (d) => (log += d))
for (let i = 0; i < 100 && !/#token=/.test(log); i++) await sleep(150)
const token = /#token=([\w-]+)/.exec(log)?.[1]
if (!token) throw new Error(`the host did not start:\n${log}`)

const exe = findBrowser()
if (!exe) throw new Error('no Chrome/Edge/Chromium found')
const chrome = await launchBrowser({ executable: exe, headless: true })
try {
  const cdp = await connectCdp(chrome.wsUrl)
  const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
  const call = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId)
  const evaluate = async (expression: string) => ((await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown } }).result?.value
  const shot = async (name: string, width: number, height: number, dark = false) => {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: width < 600 })
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'dark' : 'light' }] })
    await sleep(500)
    const r = (await call('Page.captureScreenshot', { format: 'png' })) as { data: string }
    writeFileSync(join(out, `${name}.png`), Buffer.from(r.data, 'base64'))
    console.log('saved', `docs/img/${name}.png`)
  }
  await call('Page.enable')
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/#token=${token}` })
  await sleep(2500)
  await shot('home', 1440, 900)

  // Start the scripted conversation through the real composer.
  await evaluate(`(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, 'The cart total ignores quantities. Fix it and run the tests.'); t.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await sleep(300)
  await evaluate(`(() => { const t = document.querySelector('textarea'); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`)
  await sleep(9000)
  await shot('session', 1440, 900)
  // The theme is remembered by the page itself, so switch it there and reload.
  await evaluate("localStorage.setItem('vara.theme', 'vara')")
  await call('Page.reload')
  await sleep(3000)
  await shot('session-dark', 1440, 900, true)
  await evaluate("localStorage.setItem('vara.theme', 'light')")
  await call('Page.reload')
  await sleep(3000)
  await shot('mobile', 390, 844)
} finally {
  await chrome.close?.()
  host.kill()
  model.close()
}
