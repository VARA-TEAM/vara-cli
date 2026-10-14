#!/usr/bin/env node
/**
 * Builds the downloadable VARA package for THIS platform:
 *
 *   release/out/vara-<os>-<arch>.zip | .tar.gz
 *     vara/
 *       node(.exe)   the Node runtime that built it — users install nothing
 *       vara.mjs     the whole app in one bundled file
 *       vara | vara.cmd   launchers
 *
 * Usage: node scripts/package-release.mjs [--version 0.1.0]
 * (run on each OS: the Node binary inside must match the platform)
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const version = (flag('--version') ?? pkg.version).replace(/^v/, '')
const os = { win32: 'win', darwin: 'macos', linux: 'linux' }[process.platform]
if (!os) throw new Error(`unsupported platform ${process.platform}`)
const arch = process.arch
const label = `vara-${os}-${arch}`

const outDir = join(root, 'release', 'out')
const stage = join(root, 'release', 'stage')
const app = join(stage, 'vara')
rmSync(stage, { recursive: true, force: true })
mkdirSync(app, { recursive: true })
mkdirSync(outDir, { recursive: true })

// 1. One bundled file. Ink only touches react-devtools-core when DEV=true, so it is stubbed.
await build({
  entryPoints: [join(root, 'src', 'cli.tsx')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: join(app, 'vara.mjs'),
  alias: { 'react-devtools-core': join(root, 'scripts', 'devtools-stub.mjs') },
  define: { __VARA_VERSION__: JSON.stringify(version) },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
  legalComments: 'none',
  minify: false,
})

// 2. The runtime and launchers.
const nodeName = process.platform === 'win32' ? 'node.exe' : 'node'
copyFileSync(process.execPath, join(app, nodeName))
if (process.platform === 'win32') {
  writeFileSync(join(app, 'vara.cmd'), '@echo off\r\n"%~dp0node.exe" "%~dp0vara.mjs" %*\r\n')
} else {
  // Follows symlinks (the installer links ~/.local/bin/vara here) with portable tools only.
  writeFileSync(
    join(app, 'vara'),
    `#!/bin/sh
SELF="$0"
while [ -h "$SELF" ]; do
  D="$(cd "$(dirname "$SELF")" && pwd)"
  SELF="$(readlink "$SELF")"
  case "$SELF" in /*) ;; *) SELF="$D/$SELF" ;; esac
done
DIR="$(cd "$(dirname "$SELF")" && pwd)"
exec "$DIR/node" "$DIR/vara.mjs" "$@"
`,
  )
  chmodSync(join(app, 'vara'), 0o755)
  chmodSync(join(app, nodeName), 0o755)
}
for (const f of ['README.md', 'LICENSE']) {
  try {
    copyFileSync(join(root, f), join(app, f))
  } catch {
    /* no such file (the repository has no LICENSE yet) */
  }
}

// 3. Archive: zip on Windows (opens anywhere), tar.gz elsewhere (keeps the executable bit).
const archive = join(outDir, process.platform === 'win32' ? `${label}.zip` : `${label}.tar.gz`)
rmSync(archive, { force: true })
// On Windows use the system bsdtar explicitly: a Git-for-Windows `tar` earlier on PATH reads "C:" as a remote host.
if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-a', '-c', '-f', archive, '-C', stage, 'vara'], { stdio: 'inherit' })
else execFileSync('tar', ['-czf', archive, '-C', stage, 'vara'], { stdio: 'inherit' })

const sha = createHash('sha256').update(readFileSync(archive)).digest('hex')
console.log(`${archive}\nsha256 ${sha}`)
