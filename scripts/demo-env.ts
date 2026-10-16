/**
 * The demo environment shared by the screenshot and recording scripts: a throw-away project with one bug, a scripted
 * OpenAI-compatible "model", `vara ui` pointed at it, and a real headless Chrome driven over the DevTools Protocol.
 * What the pictures show is the real interface; what the "model" says is a script.
 */
import { execSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { findBrowser, launchBrowser } from '../src/browser/chrome.js'
import { connectCdp } from '../src/browser/cdp.js'

export const root = resolve(process.cwd())
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

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

export async function startDemo(opts: { stepDelayMs?: number; port?: number } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'vara-demo-home-'))
  const project = mkdtempSync(join(tmpdir(), 'vara-demo-'))
  mkdirSync(join(project, 'src'), { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'cart', scripts: { test: 'node --test' } }, null, 2))
  writeFileSync(join(project, 'src', 'cart.js'), 'export function total(items) {\n  return items.reduce((sum, i) => sum + i.price, 0) // forgets the quantity\n}\n')
  writeFileSync(join(project, 'cart.test.js'), "import test from 'node:test'\nimport assert from 'node:assert'\nimport { total } from './src/cart.js'\ntest('total counts quantity', () => assert.equal(total([{ price: 5, qty: 2 }]), 10))\n")
  execSync('git init -q && git add -A && git -c user.email=demo@example.com -c user.name=demo commit -q -m initial', { cwd: project })

  let turn = 0
  const model = createServer((req, res) => {
    if (req.url?.endsWith('/models')) return void res.end(JSON.stringify({ data: [{ id: 'demo-model' }] }))
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      let stream = false
      try {
        stream = (JSON.parse(body) as { stream?: boolean }).stream === true
      } catch {
        /* not JSON */
      }
      const step = script[Math.min(turn++, script.length - 1)]!
      const n = turn
      setTimeout(() => {
        const delta: Record<string, unknown> = {}
        if (step.text) delta['content'] = step.text
        if (step.tool) delta['tool_calls'] = [{ index: 0, id: `call_${n}`, type: 'function', function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }]
        const usage = { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 }
        const finish = step.tool ? 'tool_calls' : 'stop'
        if (!stream) return void res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...delta }, finish_reason: finish }], usage }))
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: finish }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ choices: [], usage })}\n\n`)
        res.end('data: [DONE]\n\n')
      }, opts.stepDelayMs ?? 0)
    })
  })
  await new Promise<void>((r) => model.listen(0, '127.0.0.1', r))
  const modelPort = (model.address() as { port: number }).port
  writeFileSync(
    join(home, 'config.json'),
    JSON.stringify({
      provider: { id: 'openai', name: 'demo', keyless: true, baseUrl: `http://127.0.0.1:${modelPort}/v1`, model: 'demo-model' },
      providers: { demo: { type: 'openai', label: 'Demo model', baseUrl: `http://127.0.0.1:${modelPort}/v1`, keyless: true, apiKeySecret: '', apiKeyEnv: '', models: { 'demo-model': { status: 'ok' } } } },
      updates: { check: false },
    }),
  )

  const port = opts.port ?? 7791
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
  const cdp = await connectCdp(chrome.wsUrl)
  const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
  const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
  const call = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId)
  const evaluate = async (expression: string) => ((await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })) as { result?: { value?: unknown } }).result?.value
  const viewport = (width: number, height: number, scale = 2) => call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: width < 600 })
  /** A PNG of the page as it is right now (base64). */
  const png = async () => ((await call('Page.captureScreenshot', { format: 'png' })) as { data: string }).data
  const setText = (text: string) => evaluate(`(() => { const t = document.querySelector('textarea'); const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set; set.call(t, ${JSON.stringify(text)}); t.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  const pressEnter = () => evaluate(`document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  const clickText = (text: string) => evaluate(`(() => { const b = [...document.querySelectorAll('button, a, [role=button]')].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (b) b.click(); return !!b })()`)
  await call('Page.enable')
  await call('Page.navigate', { url: `http://127.0.0.1:${port}/#token=${token}` })
  await sleep(2500)
  return {
    call,
    evaluate,
    viewport,
    png,
    setText,
    pressEnter,
    clickText,
    async stop() {
      await chrome.close?.()
      host.kill()
      model.close()
    },
  }
}
