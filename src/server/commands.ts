import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { join, resolve } from 'node:path'
import { loadConfig, persistConfig, type VaraConfig } from '../config/config.js'
import { ensureProviders } from '../config/providers.js'
import { hostDir } from '../config/paths.js'
import { ensureStore } from '../core/store.js'
import { buildProvider, keySource, resolveApiKey } from '../runtime.js'
import { checkModel, discoverModels, mapLimit } from '../llm/discovery.js'
import { deleteSecret, setSecret } from '../security/vault.js'
import { registerSecret } from '../security/redact.js'
import type { Provider } from '../llm/provider.js'
import { Manager } from './manage.js'
import { McpHub } from '../mcp/hub.js'
import { AccessStore, presetGrant, type Grant, type GrantPreset } from './access.js'
import { VaraHost } from './host.js'
import { newOwnerToken, startServer } from './http.js'

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

/** `vara serve` / `vara ui`: run the host. */
export async function serveCommand(args: string[], open: boolean): Promise<void> {
  const lan = args.includes('--lan')
  const port = Number(flag(args, '--port') ?? DEFAULT_PORT)
  const publicHost = flag(args, '--public-host')
  const cwd = resolve(flag(args, '--cwd') ?? process.cwd())
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535')

  await ensureStore()
  let config: VaraConfig = ensureProviders(await loadConfig())
  let provider: Provider
  try {
    provider = (await buildProvider(config)).provider
  } catch (err) {
    throw new Error(`${(err as Error).message}\nRun: vara setup`)
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
  const host = new VaraHost({ config: () => config, provider: () => provider, hub, access, cwd, providerVersion: () => providerVersion, applyConfig })
  const manager = new Manager({
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
    keyState: (entry) => keySource(entry),
    mapLimit,
  })
  const ownerToken = newOwnerToken()
  let guestBase: string | undefined
  const server = await startServer({
    host,
    manager,
    ownerToken,
    publicUrl: () => guestBase,
    bind: lan ? '0.0.0.0' : '127.0.0.1',
    port,
    allowedHosts: publicHost ? [publicHost] : [],
    onError: (e) => console.error('[vara] internal error:', e instanceof Error ? e.message : e),
  })

  const lanUrls = lan ? lanAddresses().map((ip) => `http://${ip}:${server.port}`) : []
  const baseUrl = publicHost ? `https://${publicHost}` : (lanUrls[0] ?? `http://127.0.0.1:${server.port}`)
  // Invites made in the browser must carry the address a guest can actually reach.
  guestBase = lan || publicHost ? baseUrl : undefined
  writeFileSync(hostInfoFile(), JSON.stringify({ pid: process.pid, port: server.port, baseUrl } satisfies HostInfo))

  const ownerUrl = `http://127.0.0.1:${server.port}/#token=${ownerToken}`
  console.log(`VARA host running - folder: ${cwd}`)
  console.log(`\n  You:      ${ownerUrl}`)
  if (lan) for (const u of lanUrls) console.log(`  Guests:   ${u}  (they need an invite: vara invite --preset collaborator)`)
  if (publicHost) console.log(`  Public:   https://${publicHost}  (through your tunnel)`)
  if (!lan && !publicHost) console.log('  Local only. Add --lan to let people on your network join.')
  console.log('\nKeep this window open. Ctrl+C stops the host and every guest session.')
  if (lan) console.log('Only invite people you trust: a guest with "build" power can change files and run commands on THIS machine.')
  if (open) openBrowser(ownerUrl)

  await new Promise<void>((done) => {
    const stop = (): void => {
      try {
        unlinkSync(hostInfoFile())
      } catch {
        /* already gone */
      }
      void host
        .closeAll()
        .then(() => server.close())
        .finally(() => {
          hub.closeAll()
          done()
        })
    }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
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
