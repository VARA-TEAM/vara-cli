#!/usr/bin/env node
import React from 'react'
import { render } from 'ink'
import { App } from './tui/App.js'
import { loadConfig, saveConfig, DEFAULT_CONFIG, persistConfig, type VaraConfig } from './config/config.js'
import { activate, activeProviderName, defaultModelFor } from './config/providers.js'
import { keySource } from './runtime.js'
import { SetupApp } from './tui/setup.js'
import { applyTheme } from './tui/theme.js'
import { VERSION } from './version.js'
import { doctorCommand } from './doctor.js'
import { updateCommand } from './update/command.js'
import { serveCommand, inviteCommand, guestsCommand } from './server/commands.js'
import { evalCommand } from './eval/command.js'
import { memoryCommand, skillsCommand } from './owner-commands.js'
import { scheduleCommand } from './schedule/command.js'
import { connectorsCommand } from './mcp/connectors-cli.js'
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
  vara                                 start the TUI (start screen: new session or pick a recent one)
  vara -c | --continue                 reopen the most recent session in this directory
  vara resume <session-id>             resume a saved session (any directory)
  vara sessions [--all]                list sessions in this directory (--all: every directory)
  vara run "<objective>" [--goal] [--plan] [--cwd <dir>] [--verify <cmd>] [--publish] [--provider <name>] [--model <id>]
                                       headless run (no TUI), prints events
  vara ui [--lan] [--port N]           open VARA in your browser (local web interface)
  vara update [--check] [--rollback]   update this install from the latest GitHub release (SHA-256 verified)
  vara serve [--public | --lan | --local] [--port N] [--bind ADDR] [--public-host NAME] [--cwd DIR] [--token-file F] [--rotate-token] [--trust-proxy] [--log text|json|journal]
                                       run VARA as a headless service (VPS, Docker, CI); also configured by VARA_PORT, VARA_BIND,
                                       VARA_PUBLIC_HOST, VARA_CWD, VARA_OWNER_TOKEN[_FILE], VARA_LOG, VARA_TRUST_PROXY. See docs/DEPLOYMENT.md
  vara ui --share [--share-via cloudflared|ssh] [--share-minutes N] [--share-preset viewer|participant|collaborator]
                                       temporary PUBLIC link through a tunnel you already have (no VARA relay)
  vara invite --preset viewer|participant|collaborator [...]   invite someone into your host
  vara guests [revoke <id>]            who has access, what they use
  vara eval --offline | --provider <name> [--model a,b] [--repeat N] [--yes]
                                       measure the cost engine ON vs OFF on small coding tasks: quality, tokens, cost (see docs/EVAL.md)
  vara connectors [list|add|remove|login|logout <id>]   ready-made MCP connectors (login = browser sign-in)
  vara memory [list|add|edit|remove]   notes that persist between sessions (off until config.memory.enabled)
  vara skills [proposals|show|approve|reject]   skills the agent proposed — nothing installs until you approve
  vara schedule [add|list|run|logs|tick|daemon…]   recurring headless runs (off until you run: vara schedule enable; local owner only)
  vara doctor [--server]               check the install (interface, provider, git, ripgrep); --server also checks a service setup
  vara --version                       print the version
  vara setup                           add providers, fetch & test their models, pick one (TUI)
  vara providers                       list providers, key status and model health
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

  if (!cmd || cmd === 'tui' || cmd === '-c' || cmd === '--continue') {
    await startTui(cmd === '-c' || cmd === '--continue' ? 'latest' : args[1])
    return
  }
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(VERSION)
    return
  }
  if (cmd === 'doctor') {
    await doctorCommand(args.slice(1))
    return
  }
  if (cmd === 'eval') {
    await evalCommand(args.slice(1))
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
  if (cmd === 'update') {
    await updateCommand(args.slice(1))
    return
  }
  if (cmd === 'serve' || cmd === 'ui') {
    await serveCommand(args.slice(1), cmd === 'ui')
    return
  }
  if (cmd === 'invite') {
    await inviteCommand(args.slice(1))
    return
  }
  if (cmd === 'guests') {
    await guestsCommand(args.slice(1))
    return
  }
  if (cmd === 'connectors') {
    await connectorsCommand(args.slice(1))
    return
  }
  if (cmd === 'memory') {
    await memoryCommand(args.slice(1))
    return
  }
  if (cmd === 'skills') {
    await skillsCommand(args.slice(1))
    return
  }
  if (cmd === 'schedule') {
    await scheduleCommand(args.slice(1))
    return
  }
  if (cmd === 'setup') {
    // At a terminal: the browser page or the terminal screen? (`--ui` / `--tui` skip the question.)
    const want = args.includes('--ui') ? 'ui' : args.includes('--tui') ? 'tui' : process.stdin.isTTY && process.stdout.isTTY ? await askInterface() : 'tui'
    if (want === 'ui') {
      await serveCommand(['--local', ...args.slice(1).filter((a) => a !== '--ui')], true)
      return
    }
    await runSetup(await loadConfig())
    return
  }
  if (cmd === 'providers') {
    await listProviders(await loadConfig())
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
  let config = await loadConfig()

  let session: Session | null = null
  if (sessionId === 'latest') {
    const here = normalizeDir(process.cwd())
    const latest = (await listSessions()).find((s) => normalizeDir(s.cwd) === here)
    if (latest) session = await loadSession(latest.id)
  } else if (sessionId) {
    session = await loadSession(sessionId)
    if (!session) fail(`No session with id ${sessionId}`)
  }

  let built: Awaited<ReturnType<typeof buildProvider>> | null = null
  try {
    built = await buildProvider(config)
  } catch (err) {
    // First run (or a removed key): open the setup screen instead of dying
    // with a message — then continue straight into the TUI.
    if (!process.stdin.isTTY) throw err
    console.log(`${(err as Error).message}
Opening setup…
`)
    config = await runSetup(config)
    built = await buildProvider(config)
  }
  const provider = built.provider
  // A session saved as "running" means the process died mid-run: no engine is
  // alive behind it. Report the truth instead of an eternal spinner — the user
  // resumes by sending a message.
  if (session && session.state === 'running') {
    session.state = 'interrupted'
    session.stateReason = 'Reopened after an abrupt exit — send a message to resume.'
  }
  // exitOnCtrlC: false — ink's default exits the process BEFORE our handler
  // runs, which silently skipped the session save on every Ctrl+C quit.
  applyTheme(config.ui.theme)
  const restoreScreen = enterFullscreen(config.ui.fullscreen, config.ui.mouse)
  try {
    const app = render(
      <App session={session} provider={provider} config={config} autoStart={session?.state === 'idle'} />,
      { exitOnCtrlC: false },
    )
    await app.waitUntilExit()
  } finally {
    restoreScreen()
  }
}

/**
 * Own screen buffer + mouse wheel reporting. The UI then stays put (no ghost
 * frames when scrolling the terminal) and the shell's scrollback is untouched
 * on exit. Always restored — also on crashes and signals.
 */
/**
 * Each frame ink draws is erase-then-rewrite; a terminal that paints in between shows a flash (Windows Terminal
 * does, noticeably, while the agent streams). Synchronized output (DEC mode 2026) tells it to hold the screen until
 * the whole frame has arrived; terminals that do not know the mode ignore it. Frames only: ink writes one string each.
 */
const SYNC_ON = String.fromCharCode(27) + '[?2026h'
const SYNC_OFF = String.fromCharCode(27) + '[?2026l'

export function syncedFrames(out: NodeJS.WriteStream): () => void {
  const original = out.write.bind(out) as (chunk: unknown, ...rest: unknown[]) => boolean
  const patched = ((chunk: unknown, ...rest: unknown[]): boolean => {
    if (typeof chunk !== 'string' || chunk.length === 0) return original(chunk, ...rest)
    return original(SYNC_ON + chunk + SYNC_OFF, ...rest)
  }) as typeof out.write
  out.write = patched
  return () => {
    out.write = original as typeof out.write
  }
}

function enterFullscreen(fullscreen: boolean, mouse: boolean): () => void {
  if (!fullscreen || !process.stdout.isTTY) return () => {}
  const on = '\u001b[?1049h' + (mouse ? '\u001b[?1000h\u001b[?1006h' : '')
  const off = (mouse ? '\u001b[?1006l\u001b[?1000l' : '') + '\u001b[?1049l'
  let restored = false
  const restore = (): void => {
    if (restored) return
    restored = true
    unsync()
    process.stdout.write(off)
  }
  process.stdout.write(on)
  const unsync = syncedFrames(process.stdout)
  process.on('exit', restore)
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { restore(); process.exit(0) })
  return restore
}

/* ---------------- headless ---------------- */

async function headlessRun(args: string[]): Promise<void> {
  const objective = args.find((a) => !a.startsWith('--'))
  if (!objective) fail('Usage: vara run "<objective>" [--goal] [--plan] [--cwd <dir>] [--verify <cmd>] [--publish]')

  const flag = (name: string): string | undefined => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }

  let config = await loadConfig()
  const wantProvider = flag('--provider')
  if (wantProvider) {
    const entry = config.providers[wantProvider]
    if (!entry) fail(`Unknown provider "${wantProvider}". Known: ${Object.keys(config.providers).join(', ') || 'none'} — see: vara providers`)
    const chosen = flag('--model') ?? defaultModelFor(entry)
    if (!chosen) fail(`Provider "${wantProvider}" has no models yet — run: vara setup`)
    config = activate(config, wantProvider, chosen)
  }
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

/* ---------------- setup & providers ---------------- */

async function askInterface(): Promise<'ui' | 'tui'> {
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = (await rl.question('Set up in: 1) the browser page (recommended)   2) this terminal  [1]: ')).trim()
    return answer === '2' ? 'tui' : 'ui'
  } finally {
    rl.close()
  }
}

/** Run the interactive setup screen; resolves with the saved config. */
async function runSetup(config: VaraConfig): Promise<VaraConfig> {
  let result = config
  applyTheme(config.ui.theme)
  const app = render(<SetupApp config={config} onResult={(c) => (result = c)} />)
  await app.waitUntilExit()
  await persistConfig(result)
  return result
}

async function listProviders(config: VaraConfig): Promise<void> {
  const active = activeProviderName(config)
  const names = Object.keys(config.providers)
  if (!names.length) {
    console.log('No providers configured. Run: vara setup')
    return
  }
  for (const name of names) {
    const e = config.providers[name]!
    const key = await keySource(e)
    const models = Object.entries(e.models)
    const ok = models.filter(([, m]) => m.status === 'ok').length
    const bad = models.filter(([, m]) => m.status === 'fail').length
    console.log(`${name === active ? '*' : ' '} ${name}  [${e.type}]  ${e.baseUrl}  key: ${key}  models: ${models.length} (${ok} ok, ${bad} down)`)
    for (const [id, m] of models.slice(0, 30)) {
      const mark = m.status === 'ok' ? 'OK  ' : m.status === 'fail' ? 'DOWN' : '----'
      const inUse = name === active && id === config.provider.model ? '  <- in use' : ''
      console.log(`      ${mark} ${id}${m.contextWindow ? `  ctx ${m.contextWindow}` : ''}${inUse}`)
    }
    if (models.length > 30) console.log(`      … ${models.length - 30} more (use: vara setup)`)
  }
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
