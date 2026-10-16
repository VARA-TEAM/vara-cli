/**
 * Makes the README screenshots from the REAL web interface (see scripts/demo-env.ts for what is real and what is
 * scripted).   npm run build && npx tsx scripts/capture-screens.ts      → docs/img/*.png
 * With --review it saves the other screens (settings, palette, team…) to .taste-skill/review to look at instead.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { root, sleep, startDemo } from './demo-env.js'

const review = process.argv.includes('--review')
const out = review ? join(root, '.taste-skill', 'review') : join(root, 'docs', 'img')
mkdirSync(out, { recursive: true })
const d = await startDemo()
const save = async (name: string, w: number, h: number, scale = 2) => {
  await d.viewport(w, h, scale)
  await sleep(500)
  writeFileSync(join(out, `${name}.png`), Buffer.from(await d.png(), 'base64'))
  console.log('saved', name)
}
try {
  if (review) {
    await d.clickText('Settings')
    await sleep(1200)
    await save('settings', 1440, 900, 1)
    for (const tab of ['Connectors', 'Memory', 'Skills', 'Models', 'Modes']) {
      if (await d.clickText(tab)) {
        await sleep(900)
        await save(`settings-${tab.toLowerCase()}`, 1440, 900, 1)
      }
    }
    await d.clickText('Team')
    await sleep(900)
    await save('team', 1440, 900, 1)
    await d.evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }))")
    await sleep(700)
    await save('palette', 1440, 900, 1)
  } else {
    await save('home', 1440, 900)
    await d.setText('The cart total ignores quantities. Fix it and run the tests.')
    await sleep(300)
    await d.pressEnter()
    await sleep(9000)
    await save('session', 1440, 900)
    await d.evaluate("localStorage.setItem('vara.theme', 'vara')")
    await d.call('Page.reload')
    await sleep(3000)
    await save('session-dark', 1440, 900)
    await d.evaluate("localStorage.setItem('vara.theme', 'light')")
    await d.call('Page.reload')
    await sleep(3000)
    await save('mobile', 390, 844)
  }
} finally {
  await d.stop()
}
