// Writes design/tokens.mjs as CSS into the web interface. Run after editing the tokens: `node scripts/build-tokens.mjs`.
import { writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tokensCss } from '../design/tokens.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const TARGETS = ['ui/src/tokens.css']
const css = tokensCss()

if (process.argv.includes('--check')) {
  const stale = TARGETS.filter((t) => !existsSync(join(root, t)) || readFileSync(join(root, t), 'utf8') !== css)
  if (stale.length) { console.error('Out of date, run node scripts/build-tokens.mjs:', stale.join(', ')); process.exit(1) }
  console.log('tokens are in sync')
} else {
  for (const t of TARGETS) writeFileSync(join(root, t), css)
  console.log('tokens written to', TARGETS.length, 'places,', css.length, 'bytes each')
}
