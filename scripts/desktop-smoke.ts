/**
 * A REAL, NON-DESTRUCTIVE check of desktop control on this machine: reads the screen size, takes a screenshot,
 * reads the title of the window in front, and nudges the pointer. It never clicks or types.
 * Run: npx tsx scripts/desktop-smoke.ts
 */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { platformDriver } from '../src/desktop/driver.js'

const d = platformDriver()
console.log('driver:', d.name)
const { png, shot } = await d.screenshot()
const out = join(tmpdir(), 'vara-desktop-smoke.png')
writeFileSync(out, png)
console.log(`screenshot ${shot.width}x${shot.height} (scale ${shot.scale}) → ${out} (${png.length} bytes)`)
console.log('window in front:', JSON.stringify(await d.activeWindowTitle()))
if (process.argv.includes('--move')) {
  await d.move(200, 200)
  console.log('pointer moved to 200,200')
}
