/**
 * Records the TERMINAL interface for the README: the real `vara` runs in a real pseudo-terminal, its output is drawn by
 * xterm.js in headless Chrome, and the page is screenshotted. The model is the same script as the web demo.
 *
 * One-time setup (kept out of VARA's own dependencies):
 *   mkdir -p .taste-skill/tui-tools && cd .taste-skill/tui-tools && npm init -y && npm i node-pty @xterm/xterm
 * Then:  npm run build && npx tsx scripts/record-tui.ts      → docs/img/tui.png, docs/img/tui-start.png, docs/img/tui.gif
 * Needs Chrome and ffmpeg on PATH.
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { findBrowser, launchBrowser } from '../src/browser/chrome.js'
import { connectCdp } from '../src/browser/cdp.js'
import { root, sleep, startDemo } from './demo-env.js'

const tools = join(root, '.taste-skill', 'tui-tools')
const req = createRequire(join(tools, 'package.json'))
const pty = req('node-pty') as typeof import('node-pty')
const xtermDir = join(tools, 'node_modules', '@xterm', 'xterm')

const COLS = 104
const ROWS = 30
const message = 'The cart total ignores quantities. Fix it and run the tests.'
const demo = await startDemo({ stepDelayMs: 1100, web: false })
const frames = mkdtempSync(join(tmpdir(), 'vara-tui-frames-'))
const page = join(frames, 'term.html')
writeFileSync(
  page,
  `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(join(xtermDir, 'css', 'xterm.css')).href}">
<style>html,body{margin:0;background:#0A1118;overflow:hidden}#t{padding:18px 20px;display:inline-block}.xterm-viewport{overflow:hidden!important}</style>
<div id="t"></div><script src="${pathToFileURL(join(xtermDir, 'lib', 'xterm.js')).href}"></script>
<script>
  window.term = new Terminal({ cols: ${COLS}, rows: ${ROWS}, fontFamily: 'Cascadia Mono, Consolas, Menlo, monospace', fontSize: 15, lineHeight: 1.18, cursorBlink: false,
    theme: { background: '#0A1118', foreground: '#E8EEF3', cursor: '#46C6D6', selectionBackground: '#22313F' } })
  term.open(document.getElementById('t'))
  window.feed = (b64) => term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)))
</script>`,
)

const shell = pty.spawn(process.execPath, [join(root, 'dist', 'cli.js')], {
  name: 'xterm-256color',
  cols: COLS,
  rows: ROWS,
  cwd: demo.project,
  env: { ...process.env, VARA_HOME: demo.home, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '3' } as Record<string, string>,
})

const exe = findBrowser()
if (!exe) throw new Error('no Chrome/Edge/Chromium found')
const chrome = await launchBrowser({ executable: exe, headless: true })
const cdp = await connectCdp(chrome.wsUrl)
const { targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string }
const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string }
const call = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId)
await call('Page.enable')
await call('Emulation.setDeviceMetricsOverride', { width: 1000, height: 640, deviceScaleFactor: 1, mobile: false })
await call('Page.navigate', { url: pathToFileURL(page).href })
await sleep(1200)
let pending = ''
let seen = ''
shell.onData((d) => ((pending += d), (seen += d)))
const flush = async () => {
  if (!pending) return
  const chunk = pending
  pending = ''
  await call('Runtime.evaluate', { expression: `feed(${JSON.stringify(Buffer.from(chunk, 'utf8').toString('base64'))})` })
}
let n = 0
const grab = async (name?: string) => {
  await flush()
  await sleep(40)
  const shot = (await call('Page.captureScreenshot', { format: 'png' })) as { data: string }
  const buf = Buffer.from(shot.data as string, 'base64')
  writeFileSync(join(frames, `f${String(n++).padStart(4, '0')}.png`), buf)
  if (name) {
    mkdirSync(join(root, 'docs', 'img'), { recursive: true })
    writeFileSync(join(root, 'docs', 'img', `${name}.png`), buf)
    console.log('saved', name)
  }
}
const every = async (ms: number, body: () => Promise<void>) => {
  const t = Date.now()
  await body()
  const left = ms - (Date.now() - t)
  if (left > 0) await sleep(left)
}
try {
  // The start screen settles.
  for (let i = 0; i < 14; i++) await every(150, () => grab())
  await grab('tui-start')
  for (let i = 0; i < message.length; i += 2) {
    shell.write(message.slice(i, i + 2))
    await every(90, () => grab())
  }
  for (let i = 0; i < 4; i++) await every(150, () => grab())
  shell.write('\r')
  for (let i = 0, after = 0; i < 150 && after < 8; i++) {
    await every(150, () => grab())
    if (/SESSION COMPLETE/.test(seen)) after++
  }
  await grab('tui')
  const out = join(root, 'docs', 'img', 'tui.gif')
  execFileSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error', '-framerate', '7', '-i', join(frames, 'f%04d.png'),
      '-vf', 'scale=900:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=4,split[a][b];[a]palettegen=max_colors=64:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
      '-loop', '0', out,
    ],
    { stdio: 'inherit' },
  )
  console.log('saved docs/img/tui.gif from', n, 'frames')
} finally {
  shell.kill()
  await chrome.close?.()
  await demo.stop()
  rmSync(frames, { recursive: true, force: true })
}
