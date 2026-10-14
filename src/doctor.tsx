import React from 'react'
import { render } from 'ink'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { VERSION } from './version.js'
import { configFile, VARA_HOME } from './config/paths.js'
import { loadConfig } from './config/config.js'
import { keySource } from './runtime.js'
import { activeProviderName, ensureProviders } from './config/providers.js'
import { HomeScreen } from './tui/home.js'

interface Check {
  name: string
  ok: boolean
  /** A failure that does not stop VARA from working (e.g. no ripgrep). */
  optional?: boolean
  detail: string
}

/** Render the start screen into memory: proves Ink, Yoga and React work in THIS build on THIS machine. */
async function uiRenders(): Promise<{ ok: boolean; detail: string }> {
  const out = new PassThrough() as PassThrough & { columns: number; rows: number; isTTY: boolean }
  out.columns = 100
  out.rows = 30
  out.isTTY = false
  let text = ''
  out.on('data', (c: Buffer) => (text += c.toString('utf8')))
  const app = render(
    <HomeScreen input="" kind="auto" mode="build" providerName="doctor" model="self-test" cwd={process.cwd()} recent={[]} selected={-1} columns={100} version={VERSION} />,
    { stdout: out as never, stdin: new PassThrough() as never, patchConsole: false, exitOnCtrlC: false, debug: true },
  )
  await new Promise((r) => setTimeout(r, 150))
  app.unmount()
  const ok = text.includes('Ask anything')
  return { ok, detail: ok ? 'start screen rendered' : 'the interface did not render' }
}

function has(cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' && !cmd.endsWith('.exe') })
    return r.status === 0 ? (r.stdout || r.stderr).trim().split('\n')[0] ?? 'ok' : null
  } catch {
    return null
  }
}

/** `vara doctor`: what works, what is missing, and how to fix it. Exit code 1 if something required fails. */
export async function doctorCommand(): Promise<void> {
  const checks: Check[] = []
  checks.push({ name: 'VARA', ok: true, detail: `v${VERSION} on ${process.platform}/${process.arch}, Node ${process.versions.node}` })
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({ name: 'Node.js', ok: nodeMajor >= 20, detail: nodeMajor >= 20 ? `v${process.versions.node}` : `v${process.versions.node} is too old (need 20+)` })

  const ui = await uiRenders().catch((e: Error) => ({ ok: false, detail: e.message }))
  checks.push({ name: 'Interface', ok: ui.ok, detail: ui.detail })

  checks.push({ name: 'Data folder', ok: true, detail: `${VARA_HOME}${existsSync(configFile) ? '' : ' (created on first run)'}` })
  try {
    const config = ensureProviders(await loadConfig())
    const name = activeProviderName(config)
    const key = await keySource(config.provider)
    checks.push({
      name: 'Provider',
      ok: key !== 'none',
      // A missing key is the normal state of a fresh install, not a broken one.
      optional: true,
      detail: key === 'none' ? `${name}: no API key — run: vara setup` : `${name} · ${config.provider.model} (key: ${key})`,
    })
  } catch (err) {
    checks.push({ name: 'Provider', ok: false, detail: (err as Error).message.split('\n')[0] ?? 'config unreadable' })
  }

  const git = has('git', ['--version'])
  checks.push({ name: 'git', ok: !!git, optional: true, detail: git ?? 'not found — VARA cannot show diffs or commit' })
  const rg = has('rg', ['--version'])
  checks.push({ name: 'ripgrep', ok: !!rg, optional: true, detail: rg ?? 'not found — search falls back to a slower built-in engine' })

  let broken = false
  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : c.optional ? 'todo' : 'FAIL'
    if (!c.ok && !c.optional) broken = true
    console.log(`${mark}  ${c.name.padEnd(12)} ${c.detail}`)
  }
  if (broken) process.exitCode = 1
  else if (checks.some((c) => !c.ok)) console.log('\nThe install works. Items marked "todo" are optional or one-time setup (start with: vara setup).')
}
