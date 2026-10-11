#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { App } from './tui/App.js'
import { loadConfig, saveConfig, DEFAULT_CONFIG } from './config/config.js'
import { ensureStore, listSessions, loadSession, saveSession } from './core/store.js'
import { createSession, CreateSessionInput } from './core/session.js'
import { buildProvider } from './runtime.js'
import { Engine } from './core/engine.js'
import { setSecret, listSecrets, deleteSecret } from './security/vault.js'
import { getMasterKey } from './security/vault.js'
import { scrubAll } from './security/redact.js'
import { formatUsd } from './llm/cost.js'
import type { Session } from './core/types.js'

const USAGE = `VARA — an autonomous agent execution engine.

Usage:
  vara                                 start the TUI (new session in this directory)
  vara resume <session-id>             resume a saved session (any directory)
  vara sessions [--all]                list sessions in this directory (--all: every directory)
  vara run "<objective>" [--goal] [--plan] [--cwd <dir>] [--verify <cmd>] [--publish]
                                       headless run (no TUI), prints events
  vara secret set <NAME>               store a secret in the encrypted vault
  vara secret list                     list stored secrets (names only)
  vara secret delete <NAME>            remove a secret
  vara config init                     write the default config to ~/.vara/config.json
  vara config show                     print the config (secrets never shown)

Env: VARA_HOME overrides ~/.vara`
  .trim()

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const cmd = args[0]

  await ensureStore()

  if (!cmd || cmd === 'tui') {
    await startTui(args[1])
    return
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(USAGE)
    return
  }
  if (cmd === 'sessions') {
    const all = await listSessions()
    const allFlag = args.includes('--all')
    const here = normalizeDir(process.cwd())
    const sessions = allFlag ? all : all.filter((s) => normalizeDir(s.cwd) === here)
    if (!sessions.length) {
      console.log(
        allFlag || !all.length
          ? 'No sessions yet.'
          : `No sessions for this directory (${process.cwd()}). ${all.length} other session(s) exist — see: vara sessions --all`,
      )
      return
    }
    if (!allFlag) console.log(`Sessions in ${process.cwd()} (use --all for every directory):\n`)
    for (const s of sessions) {
      console.log(`${s.id}  [${s.kind}/${s.state}]  ${s.objective}`)
      const cost = s.costUsd === null ? 'unknown' : `${formatUsd(s.costUsd)}${s.unpricedCalls > 0 ? '+' : ''}`
      console.log(`           ${s.cwd}  ·  ${s.updatedAt}  ·  cost ${cost}`)
    }
    return
  }
  if (cmd === 'resume') {
    const id = args[1]
    if (!id) return fail('Usage: vara resume <session-id>')
    await startTui(id)
    return
  }
  if (cmd === 'run') {
    await headlessRun(args.slice(1))
    return
  }
  if (cmd === 'secret') {
    await secretCommand(args.slice(1))
    return
  }
  if (cmd === 'config') {
    await configCommand(args.slice(1))
    return
  }
  fail(`Unknown command: ${cmd}\n\n${USAGE}`)
}

function fail(message: string): never {
  console.error(message)
  process.exit(1)
}

/** Case-insensitive, trailing-slash-free directory comparison (Windows-safe). */
function normalizeDir(dir: string): string {
  const resolved = dir.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/* ---------------- TUI ---------------- */

async function startTui(sessionId?: string): Promise<void> {
  const config = await loadConfig()

  let session: Session | null = null
  if (sessionId) {
    session = await loadSession(sessionId)
    if (!session) fail(`No session with id ${sessionId}`)
  } else {
    // Open the most recent session in this directory directly (OpenCode-style):
    // no console questionnaire — the TUI shows the transcript, and the user
    // picks it up or starts fresh with Ctrl+N / the welcome screen.
    const here = normalizeDir(process.cwd())
    const sessions = await listSessions()
    const latest = sessions.find((s) => normalizeDir(s.cwd) === here)
    if (latest) session = await loadSession(latest.id)
  }

  const { provider } = await buildProvider(config)
  // A session saved as "running" means the process died mid-run: no engine is
  // alive behind it. Report the truth instead of an eternal spinner — the user
  // resumes by sending a message.
  if (session && session.state === 'running') {
    session.state = 'interrupted'
    session.stateReason = 'Reopened after an abrupt exit — send a message to resume.'
  }
  // exitOnCtrlC: false — ink's default exits the process BEFORE our handler
  // runs, which silently skipped the session save on every Ctrl+C quit.
  render(
    <App session={session} provider={provider} config={config} autoStart={session?.state === 'idle'} />,
    { exitOnCtrlC: false },
  )
}

/* ---------------- headless ---------------- */

async function headlessRun(args: string[]): Promise<void> {
  const objective = args.find((a) => !a.startsWith('--'))
  if (!objective) fail('Usage: vara run "<objective>" [--goal] [--plan] [--cwd <dir>] [--verify <cmd>] [--publish]')

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }

  const config = await loadConfig()
  const parsed = CreateSessionInput.parse({
    kind: args.includes('--goal') ? 'goal' : 'task',
    mode: args.includes('--plan') ? 'plan' : 'build',
    objective,
    cwd: flag('--cwd') ?? process.cwd(),
    verifyCommand: flag('--verify') ?? config.defaultVerifyCommand ?? undefined,
    allowPublish: args.includes('--publish') || config.allowPublish,
    model: flag('--model') ?? config.provider.model,
  })
  const session = createSession(parsed, config)
  await saveSession(session)

  const { provider } = await buildProvider(config)
  const engine = new Engine({
    session,
    provider,
    onEvent: (event) => {
      if (event.type === 'text') process.stdout.write(event.delta)
      else if (event.type === 'tool_start') process.stdout.write(`\n[${session.usage.turns}] > ${event.name} ${scrubAll(event.args).slice(0, 140)}\n`)
      else if (event.type === 'tool_end') process.stdout.write(`${event.ok ? '  ok' : '  FAIL'}: ${scrubAll(event.output).split('\n')[0]}\n`)
      else if (event.type === 'state') process.stdout.write(`\n-- ${event.state}${event.reason ? `: ${event.reason}` : ''} --\n`)
      else if (event.type === 'completed') process.stdout.write(`\n== COMPLETED ==\n${event.summary}\n`)
      else if (event.type === 'budget_warning') process.stdout.write(`\n** ${event.message}\n`)
      else if (event.type === 'session_summary') {
        process.stdout.write(`\n== SESSION SUMMARY ==\n${event.summary}\n`)
        for (const r of event.requirements) {
          process.stdout.write(`  ${r.verified ? '[x]' : '[ ]'} ${r.id}. ${r.text.slice(0, 160)}\n`)
        }
        process.stdout.write(`  ${event.turns} turns, ${event.toolCalls} tool calls, ${Math.round(event.elapsedMs / 1000)}s\n`)
        process.stdout.write(
          event.costUsd === null || event.costUsd === undefined
            ? '  cost: unknown (no usage or pricing available)\n'
            : `  cost: ${formatUsd(event.costUsd)}${event.costPartial ? ' (partial — some calls unpriced)' : ''}\n`,
        )
      } else if (event.type === 'error') process.stderr.write(`\n!! ${event.message}\n`)
    },
  })

  process.on('SIGINT', () => {
    engine.stop()
    session.state = 'paused'
  })

  await engine.run()
  await saveSession(session)
  console.log(`\nSession ${session.id} → ${session.state}${session.stateReason ? ` (${session.stateReason})` : ''}`)
}

/* ---------------- secrets & config ---------------- */

async function secretCommand(args: string[]): Promise<void> {
  const sub = args[0]
  if (sub === 'set') {
    const name = args[1]
    if (!name) fail('Usage: vara secret set <NAME>')
    const readline = await import('node:readline/promises')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const value = (await rl.question(`Value for ${name}: `)).trim()
    rl.close()
    if (!value) fail('Empty value.')
    const ref = await setSecret(name, value)
    const { protection } = await getMasterKey()
    console.log(`Stored ${ref.name} (hint ${ref.hint}) — encrypted, protected by: ${protection}`)
    return
  }
  if (sub === 'list') {
    const secrets = await listSecrets()
    if (!secrets.length) {
      console.log('Vault is empty.')
      return
    }
    for (const s of secrets) console.log(`${s.name}  scope=${s.scope}  ${s.hint}`)
    return
  }
  if (sub === 'delete') {
    const name = args[1]
    if (!name) fail('Usage: vara secret delete <NAME>')
    const removed = await deleteSecret(name)
    console.log(removed ? `Deleted ${name}` : `No secret named ${name}`)
    return
  }
  fail('Usage: vara secret <set|list|delete>')
}

async function configCommand(args: string[]): Promise<void> {
  const sub = args[0]
  if (sub === 'init') {
    await saveConfig(DEFAULT_CONFIG)
    console.log(`Wrote default config. Edit it to point at your provider (OpenAI-compatible or Anthropic).`)
    return
  }
  if (sub === 'show') {
    const config = await loadConfig()
    console.log(JSON.stringify(config, null, 2))
    return
  }
  fail('Usage: vara config <init|show>')
}

main().catch((err: unknown) => {
  console.error(`VARA failed: ${(err as Error).message}`)
  process.exit(1)
})
