/**
 * Records the README demo GIF from the REAL web interface: a message is typed, the (scripted) agent looks, reads,
 * fixes, runs the tests and the evidence panel fills in. Needs Chrome and ffmpeg on PATH.
 *   npm run build && npx tsx scripts/record-demo.ts      → docs/img/demo.gif
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { root, sleep, startDemo } from './demo-env.js'

const message = 'The cart total ignores quantities. Fix it and run the tests.'
const frames = mkdtempSync(join(tmpdir(), 'vara-frames-'))
const d = await startDemo({ stepDelayMs: 1100 })
let n = 0
const grab = async () => writeFileSync(join(frames, `f${String(n++).padStart(4, '0')}.png`), Buffer.from(await d.png(), 'base64'))
const every = async (ms: number, body: () => Promise<void>) => {
  const t = Date.now()
  await body()
  const left = ms - (Date.now() - t)
  if (left > 0) await sleep(left)
}
try {
  await d.viewport(1280, 760, 1)
  await sleep(600)
  for (let i = 0; i < 6; i++) await every(150, grab) // the empty start screen
  // typing
  for (let i = 1; i <= message.length; i += 2) {
    await every(110, async () => {
      await d.setText(message.slice(0, i))
      await grab()
    })
  }
  await d.setText(message)
  for (let i = 0; i < 4; i++) await every(150, grab)
  await d.pressEnter()
  // the work, until the session is done (or 20 seconds)
  const end = Date.now() + 20_000
  let done = 0
  while (Date.now() < end && done < 14) {
    await every(150, grab)
    const text = String(await d.evaluate('document.body.innerText'))
    if (/\bdone\b/.test(text) && /Evidence/.test(text)) done++
  }
  mkdirSync(join(root, 'docs', 'img'), { recursive: true })
  const out = join(root, 'docs', 'img', 'demo.gif')
  const fps = 7
  execFileSync(
    'ffmpeg',
    [
      '-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, 'f%04d.png'),
      '-vf', `scale=960:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=4,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
      '-loop', '0', out,
    ],
    { stdio: 'inherit' },
  )
  console.log('saved docs/img/demo.gif from', n, 'frames')
} finally {
  await d.stop()
  rmSync(frames, { recursive: true, force: true })
}
