import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join } from 'node:path'
import { loadConfig, persistConfig, type VaraConfig } from '../config/config.js'
import { ensureProviders } from '../config/providers.js'
import { hostDir, VARA_HOME } from '../config/paths.js'
import { VERSION } from '../version.js'
import { isLoopback, makeLogger, makeShutdown, parseServeSettings, resolveOwnerAuth, type Env } from './daemon.js'
import { ensureStore } from '../core/store.js'
import { buildProvider, keySource, resolveApiKey } from '../runtime.js'
import { checkModel, discoverModels, mapLimit } from '../llm/discovery.js'
import { deleteSecret, listSecrets, setSecret } from '../security/vault.js'
import { registerSecret } from '../security/redact.js'
import type { Provider } from '../llm/provider.js'
import { sweepStaging } from '../core/attachments.js'
import { checkForUpdate, type UpdateNotice } from '../update/updater.js'
import { Manager } from './manage.js'
import type { HostStatus } from '../core/systeminfo.js'
import { McpHub } from '../mcp/hub.js'
import { AccessStore, presetGrant, type Grant, type GrantPreset } from './access.js'
import { VaraHost } from './host.js'
import { newOwnerToken, startServer } from './http.js'
import { DEFAULT_SHARE_MINUTES, Sharing } from './share.js'
import { PROVIDERS } from './tunnel.js'
import { hostGateway } from '../gateway/run.js'
import { askExposure, exposureArgs, exposureDecided, publicIp } from './expose.js'
import { disabledFeatures } from './features.js'

/** Stands in until the owner adds a provider in the browser; every request says what to do. */
function noProvider(): Provider {
  return {
    id: 'openai',
    // eslint-disable-next-line require-yield
    async *chat() {
      yield { type: 'error', message: 'No model provider is set up yet. Open Settings → Providers, add one and pick a model.' }
    },
  } as Provider
}

const DEFAULT_PORT = 7777

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

/** Private IPv4 addresses of this machine — what other devices on the LAN type. */
export function lanAddresses(): string[] {
  const out: string[] = []
  for (const list of Object.values(networkInterfaces())) {
    for (const i of list ?? []) if (i.family === 'IPv4' && !i.internal) out.push(i.address)
  }
  return out
}

interface HostInfo {
  pid: number
  port: number
  /** Base URL guests should use (LAN address or the tunnel host). */
  baseUrl: string
}

const hostInfoFile = (): string => join(hostDir, 'running.json')

function readHostInfo(): HostInfo | null {
  try {
    const info = JSON.parse(readFileSync(hostInfoFile(), 'utf8')) as HostInfo
    // A stale file from a host that died must not hand out dead links.
    process.kill(info.pid, 0)
    return info
  } catch {
    return null
  }
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url.replace(/&/g, '^&')]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  try {
    spawn(cmd as string, args as string[], { stdio: 'ignore', detached: true, windowsHide: true }).unref()
  } catch {
    /* the URL is printed anyway */
  }
}

export interface ServeHooks {
  /** Environment to read VARA_* settings from (default: process.env). */
  env?: Env
  /** Where log lines go (default: stdout). */
  write?: (line: string) => void
  /** Called once the server is listening. */
  onReady?: (info: { port: number; baseUrl: string; ownerUrl?: string; oneTimeToken?: string }) => void
  /** Stop the host (what SIGTERM does). Mostly for tests and embedding. */
  abort?: AbortSignal
}

/**
 * `vara serve` (headless daemon: settings from flags and VARA_* variables, an owner token that survives restarts,
 * log lines for journald/containers, a clean stop on SIGTERM) and `vara ui` (opens a browser, fresh token per run).
 */
export async function serveCommand(args: string[], open: boolean, hooks: ServeHooks = {}): Promise<void> {
  const env = hooks.env ?? process.env
  // At a terminal with nothing said about exposure: ask, instead of silently listening where a VPS cannot be reached.
  if (!hooks.env && process.stdin.isTTY && process.stdout.isTTY && !exposureDecided(args, env)) args = [...args, ...exposureArgs(await askExposure())]
  const settings = parseServeSettings(args, env, { daemon: !open })
  const { port, publicHost, cwd, daemon } = settings
  const lan = !isLoopback(settings.bind)
  const logger = makeLogger(daemon ? settings.log : 'text', hooks.write)
  // `vara ui` talks to a person at a terminal, the daemon to a log: same facts, different voice.
  const say = (line: string): void => (daemon ? logger.info(line) : (hooks.write ?? console.log)(line))

  await ensureStore()
  void sweepStaging() // uploads nobody sent with a message
  let config: VaraConfig = ensureProviders(await loadConfig())
  let provider: Provider
  try {
    provider = (await buildProvider(config)).provider
  } catch (err) {
    const key = config.provider.apiKeyEnv
    // A person at `vara ui` with no provider yet can still open the page and add one there (Settings → Providers).
    // A hosted service starts the host before its owner has a key: VARA_ALLOW_NO_PROVIDER=1 gives the daemon the same behaviour.
    if (!daemon || process.env['VARA_ALLOW_NO_PROVIDER'] === '1') {
      say('No model provider is set up yet: open the page and add one in Settings (the agent cannot answer until you do).')
      provider = noProvider()
    } else {
      throw new Error(
        `${(err as Error).message}\n` +
          `Give the host a model key before it starts: export ${key || 'the provider key variable'} (or run \`vara secret set ${config.provider.apiKeySecret || 'NAME'}\` / \`vara setup\` once with the same VARA_HOME).`,
      )
    }
  }
  let providerVersion = 0
  const hub = new McpHub()
  void hub.sync(config.mcp.servers as never)
  mkdirSync(hostDir, { recursive: true })
  const access = new AccessStore()
  // Build the provider FIRST: a change that cannot work (no key, bad URL) is refused before it is saved.
  const applyConfig = async (next: VaraConfig): Promise<void> => {
    const built = (await buildProvider(next)).provider
    config = next
    provider = built
    providerVersion++
    await persistConfig(next)
    void hub.sync(next.mcp.servers as never)
  }
  // One quiet request per day, in the background: the host never waits for it.
  let updateNotice: UpdateNotice | null = null
  void checkForUpdate({ enabled: config.updates.check }).then((n) => {
    updateNotice = n
    if (n) say(daemon ? `a new VARA is available: ${n.latest} (this is ${n.current}); update with: vara update` : `\nA new VARA is available: ${n.latest} (you have ${n.current}). Update with: vara update`)
  })
  const host = new VaraHost({ config: () => config, provider: () => provider, hub, access, cwd, update: () => updateNotice ?? undefined, providerVersion: () => providerVersion, applyConfig, hostStatus: () => hostStatus() })
  // What the owner's agent may learn about this host: how exposed it is and how many guests — never a token or a link.
  const hostStatus = (): HostStatus => {
    const s = sharing?.current()
    const guests = access.listGuests()
    return {
      exposure: publicHost ? 'public host' : lan ? 'local network' : 'local only',
      ...(publicHost ? { publicHost } : {}),
      shareActive: !!s,
      ...(s?.expiresAt ? { shareExpiresAt: s.expiresAt } : {}),
      guests: { active: guests.filter((g) => !g.revoked).length, revoked: guests.filter((g) => g.revoked).length },
      openInvites: access.listInvites().filter((i) => !i.revoked && Date.parse(i.expiresAt) > Date.now() && i.uses < i.maxUses).length,
    }
  }
  const gateway = hostGateway(host, () => config, (l) => say(l))
  const manager = new Manager({
    gateway,
    config: () => config,
    apply: applyConfig,
    hub,
    cwd,
    discover: (ep) => discoverModels(ep),
    check: (ep, model) => checkModel(ep, model),
    endpoint: async (entry) => ({ type: entry.type, baseUrl: entry.baseUrl, apiKey: await resolveApiKey(entry), ...(entry.flavor ? { flavor: entry.flavor } : {}) }),
    saveKey: async (name, value) => {
      await setSecret(name, value)
      registerSecret(value, name)
    },
    deleteKey: (name) => deleteSecret(name),
    secretNames: async () => (await listSecrets()).map((s) => s.name),
    keyState: (entry) => keySource(entry),
    mapLimit,
  })

  // The owner's credential: a daemon keeps only a digest (and shows a new token once); `vara ui` makes a fresh one per run.
  const auth = daemon ? resolveOwnerAuth(settings, hostDir) : null
  const ownerToken = daemon ? undefined : newOwnerToken()
  for (const w of [...settings.warnings, ...(auth?.warnings ?? [])]) (daemon ? logger.warn(w) : say(`Warning: ${w}`))

  let guestBase: string | undefined
  const wantShare = args.includes('--share')
  const allowedHosts: string[] = publicHost ? [publicHost] : []
  const publicHosts: string[] = []
  const disabled = disabledFeatures()
  if (disabled.size) say(`Turned off on this host: ${[...disabled].join(', ')}`)
  let sharing: Sharing | null = null
  let baseBeforeShare: string | undefined
  let server: Awaited<ReturnType<typeof startServer>>
  try {
    server = await startServer({
      host,
      manager,
      ...(auth ? { ownerTokenDigest: auth.digest } : { ownerToken: ownerToken! }),
      trustProxy: settings.trustProxy,
      publicUrl: () => guestBase,
      bind: settings.bind,
      port,
      allowedHosts,
      publicHosts,
      disabled,
      share: () => {
        const s = sharing?.current()
        return s ? { url: s.url, ...(s.expiresAt ? { expiresAt: s.expiresAt } : {}) } : undefined
      },
      // Internal errors are for the operator's log, never for the client; messages only, so no request data lands in the journal.
      onError: (e) => (daemon ? logger.error('internal error', { message: e instanceof Error ? e.message : String(e) }) : console.error('[vara] internal error:', e instanceof Error ? e.message : e)),
    })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new Error(`port ${port} on ${settings.bind} is already in use (another VARA host? \`vara doctor --server\` shows who). Use --port or VARA_PORT.`)
    throw err
  }

  const wantPublic = args.includes('--public')
  const outside = wantPublic ? await publicIp() : null
  const lanUrls = lan ? [...(outside ? [outside] : []), ...lanAddresses()].map((ip) => `http://${ip}:${server.port}`) : []
  const localUrl = `http://${settings.bind === '0.0.0.0' || settings.bind === '::' ? '127.0.0.1' : settings.bind}:${server.port}`
  const baseUrl = publicHost ? `https://${publicHost}` : (lanUrls[0] ?? localUrl)
  // Invites made in the browser must carry the address a guest can actually reach.
  guestBase = lan || publicHost ? baseUrl : undefined
  writeFileSync(hostInfoFile(), JSON.stringify({ pid: process.pid, port: server.port, baseUrl } satisfies HostInfo))

  baseBeforeShare = guestBase
  sharing = new Sharing({
    port: server.port,
    allowedHosts,
    publicHosts,
    setGuestBase: (u) => {
      guestBase = u ?? baseBeforeShare
      writeFileSync(hostInfoFile(), JSON.stringify({ pid: process.pid, port: server.port, baseUrl: guestBase ?? baseUrl } satisfies HostInfo))
    },
    onEnd: (why) => say(`${daemon ? '' : '\n'}[vara] Public link closed: ${why}. Guests can no longer reach this host from outside; the host keeps running locally.`),
  })

  let ownerUrl: string | undefined
  if (daemon) {
    logger.info(`VARA ${VERSION} host listening on ${settings.bind}:${server.port}`, { folder: cwd, ...(publicHost ? { publicHost } : {}), pid: process.pid, home: VARA_HOME, log: settings.log })
    if (auth?.oneTimeToken) {
      ownerUrl = `${baseUrl}/#token=${auth.oneTimeToken}`
      logger.raw('Owner login — shown ONCE. Open it (or keep the token in a password manager): only its hash is stored, so it cannot be shown again.')
      logger.raw(`  ${ownerUrl}`)
      logger.raw('If you lose it: restart with --rotate-token (the old token stops working).')
    } else if (auth) {
      logger.info(auth.source === 'persisted' ? `owner token: the one saved earlier (${auth.where}); start with --rotate-token to replace it` : `owner token: provided (${auth.where})`)
    }
    logger.info(`health check: ${localUrl}/api/health`)
  } else {
    // Where the owner opens it: a remote server's own 127.0.0.1 is no use to someone browsing from home.
    const reach = wantPublic && lanUrls[0] ? lanUrls[0] : `http://127.0.0.1:${server.port}`
    ownerUrl = `${reach}/#token=${ownerToken}`
    console.log(`VARA host running - folder: ${cwd}`)
    console.log(`\n  You:      ${ownerUrl}`)
    if (lan) for (const u of lanUrls) console.log(`  Guests:   ${u}  (they need an invite: vara invite --preset collaborator)`)
    if (wantPublic) {
      if (!outside) console.log('  (could not learn this server\'s public IP — use the IP your provider shows)')
      console.log(`  If it does not load: open port ${server.port} (ufw allow ${server.port}/tcp, and your provider's firewall / security group). It is plain HTTP: put TLS in front for anything beyond a trial.`)
    }
    if (publicHost) console.log(`  Public:   https://${publicHost}  (through your tunnel)`)
    if (!lan && !publicHost) console.log('  Local only. Add --lan to let people on your network join.')
    console.log('\nKeep this window open. Ctrl+C stops the host and every guest session.')
    if (lan) console.log('Only invite people you trust: a guest with "build" power can change files and run commands on THIS machine.')
  }
  if (wantShare && !disabled.has('tunnel')) await startShare(sharing, args, access, config)
  else if (wantShare) say('Public links are turned off on this host: --share was ignored.')
  if (open && ownerUrl) openBrowser(ownerUrl)
  hooks.onReady?.({ port: server.port, baseUrl, ...(ownerUrl ? { ownerUrl } : {}), ...(auth?.oneTimeToken ? { oneTimeToken: auth.oneTimeToken } : {}) })

  // Telegram: starts now if it is switched on and has a token; the settings screens can change that while running.
  if (!disabled.has('gateways')) await gateway.reconcile().catch((e: Error) => say(`gateway: ${e.message}`))

  const shutdown = makeShutdown({
    log: logger,
    steps: [
      {
        name: 'forget this host',
        run: () => {
          try {
            unlinkSync(hostInfoFile())
          } catch {
            /* already gone */
          }
        },
      },
      { name: 'stop sessions', run: () => host.closeAll() },
      { name: 'close the public link', run: () => sharing?.stop() },
      { name: 'stop accepting connections', run: () => server.close() },
      { name: 'stop the messaging gateways', run: () => gateway.stop() },
      { name: 'close MCP servers', run: () => hub.closeAll() },
    ],
  })

  let signals = 0
  const onInt = (): void => stop('SIGINT')
  const onTerm = (): void => stop('SIGTERM')
  const stop = (reason: string): void => {
    signals++
    // A second Ctrl+C / SIGTERM while stopping means "now": do not leave a stuck process behind.
    if (signals > 1) {
      logger.warn('second stop request: exiting now')
      process.exit(1)
    }
    void shutdown(reason).then(finish)
  }
  let finish: (r: { clean: boolean }) => void = () => {}
  const result = await new Promise<{ clean: boolean }>((done) => {
    finish = done
    process.once('SIGINT', onInt)
    process.once('SIGTERM', onTerm)
    hooks.abort?.addEventListener('abort', () => void shutdown('requested').then(done), { once: true })
    if (hooks.abort?.aborted) void shutdown('requested').then(done)
    if (daemon) {
      process.on('unhandledRejection', (e) => logger.error('unhandled rejection', { message: e instanceof Error ? e.message : String(e) }))
    }
  })
  process.off('SIGINT', onInt)
  process.off('SIGTERM', onTerm)
  if (daemon) process.exitCode = result.clean ? 0 : 1
}

/** `--share`: open the public link, print one safe (read-only) invite on it, and say plainly what is exposed. */
async function startShare(sharing: Sharing, args: string[], access: AccessStore, _config: VaraConfig): Promise<void> {
  const via = flag(args, '--share-via') ?? 'auto'
  const minutes = flag(args, '--share-minutes') === undefined ? DEFAULT_SHARE_MINUTES : Number(flag(args, '--share-minutes'))
  if (!Number.isFinite(minutes) || minutes < 0) throw new Error('--share-minutes must be 0 (until you stop) or a number of minutes')
  const preset = (flag(args, '--share-preset') ?? 'participant') as GrantPreset
  if (!['viewer', 'participant', 'collaborator'].includes(preset)) throw new Error('--share-preset must be viewer, participant or collaborator')
  const sshHost = flag(args, '--share-ssh-host')
  console.log(`\nOpening a public link (${via === 'auto' ? PROVIDERS.map((p) => p.id).join(' / ') : via})…`)
  let info
  try {
    info = await sharing.start(via, { minutes, ...(sshHost ? { sshHost } : {}) })
  } catch (err) {
    console.log(`Could not open a public link: ${(err as Error).message}\nThe host keeps running locally (add --lan for your network).`)
    return
  }
  const grant = presetGrant(preset)
  const inv = access.createInvite(grant, { label: 'public share', ttlMs: (minutes > 0 ? minutes : 24 * 60) * 60_000, maxUses: 1 })
  console.log(`  Public:   ${info.url}  (via ${info.provider}${info.expiresAt ? `, closes ${info.expiresAt}` : ', until you stop the host'})`)
  console.log(`  Invite:   ${info.url}/join/${inv.token}   (${preset}, read-only agent, one use)`)
  console.log('\n  !! This host is now reachable from the internet by anyone who has an invite link.')
  console.log('  !! The tunnel provider relays the traffic. Your owner token does NOT work through it.')
  console.log('  !! A guest with "build" power runs commands and edits files on THIS machine — keep guests on')
  console.log('     plan (read-only) unless you trust them completely, and revoke with: vara guests revoke <id>')
}

/** `vara invite`: create an invite link for the running (or next) host. */
export async function inviteCommand(args: string[]): Promise<void> {
  const preset = (flag(args, '--preset') ?? 'participant') as GrantPreset
  if (!['viewer', 'participant', 'collaborator'].includes(preset)) throw new Error('--preset must be viewer, participant or collaborator')
  const overrides: Partial<Grant> = {}
  const mode = flag(args, '--mode')
  if (mode === 'plan' || mode === 'build') overrides.mode = mode
  if (args.includes('--can-switch-mode')) overrides.canChangeMode = true
  if (args.includes('--can-interrupt')) overrides.canInterrupt = true
  const models = flag(args, '--models')
  if (models) {
    overrides.modelPolicy = 'list'
    overrides.allowedModels = models.split(',').map((m) => m.trim()).filter(Boolean)
  }
  if (args.includes('--any-model')) overrides.modelPolicy = 'any'
  const calls = Number(flag(args, '--max-calls'))
  if (calls > 0) overrides.maxModelCalls = Math.floor(calls)
  const cost = Number(flag(args, '--max-cost'))
  if (cost > 0) overrides.maxCostUsd = cost
  const hours = Number(flag(args, '--hours') ?? 24)
  const uses = Number(flag(args, '--uses') ?? 1)

  mkdirSync(hostDir, { recursive: true })
  const grant = presetGrant(preset, overrides)
  const inv = new AccessStore().createInvite(grant, { label: flag(args, '--label') ?? '', ttlMs: Math.max(1, hours) * 3_600_000, maxUses: Math.max(1, uses) })
  const info = readHostInfo()
  const base = info?.baseUrl ?? `http://<host-address>:${DEFAULT_PORT}`
  console.log(`Invite ${inv.id} - ${preset}${grant.preset === 'custom' ? ' (customised)' : ''}, valid until ${inv.expiresAt}, ${uses} use(s)`)
  console.log(`\n  ${base}/join/${inv.token}\n`)
  if (!info) console.log('No host is running. Start one with: vara ui --lan   (then send the link with the host address filled in)')
  console.log(`Guest can: ${describe(grant)}`)
  if (grant.mode === 'build') console.log('\nWARNING: "build" lets this guest agent change files and run commands on YOUR machine. Invite only people you trust.')
  console.log('The link is shown once and cannot be recovered; revoke access with: vara guests')
}

function describe(g: Grant): string {
  const parts: string[] = []
  if (g.watch) parts.push('watch your shared session')
  if (g.sendShared) parts.push('talk in it')
  if (g.ownSession) parts.push(`run their own ${g.mode === 'plan' ? 'read-only' : 'build'} session`)
  parts.push(g.modelPolicy === 'locked' ? 'model locked' : g.modelPolicy === 'list' ? `models: ${g.allowedModels.join(', ')}` : 'any model')
  if (g.maxModelCalls) parts.push(`max ${g.maxModelCalls} model calls`)
  if (g.maxCostUsd) parts.push(`max $${g.maxCostUsd}`)
  return parts.join(' / ')
}

/** `vara guests [revoke <id>]`. */
export async function guestsCommand(args: string[]): Promise<void> {
  mkdirSync(hostDir, { recursive: true })
  const store = new AccessStore()
  if (args[0] === 'revoke') {
    const id = args[1]
    if (!id) throw new Error('Usage: vara guests revoke <id>')
    console.log(store.revokeGuest(id) ? `Revoked ${id}. A running host stops their agents within seconds.` : `No guest ${id}`)
    return
  }
  const guests = store.listGuests()
  if (!guests.length) console.log('No guests yet. Invite someone: vara invite --preset collaborator')
  for (const g of guests) {
    console.log(`${g.revoked ? 'x' : '*'} ${g.id}  ${g.name.padEnd(16)} ${g.grant.preset.padEnd(12)} last seen ${g.lastSeenAt}${g.revoked ? '  (revoked)' : ''}`)
    console.log(`           ${describe(g.grant)}`)
  }
  const invites = store.listInvites().filter((i) => !i.revoked && Date.parse(i.expiresAt) > Date.now() && i.uses < i.maxUses)
  if (invites.length) {
    console.log('\nOpen invites:')
    for (const i of invites) console.log(`  ${i.id}  ${i.grant.preset}  ${i.uses}/${i.maxUses} used  until ${i.expiresAt}${i.label ? `  (${i.label})` : ''}`)
  }
}
