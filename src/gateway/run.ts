import type { VaraHost } from '../server/host.js'
import { getSecretsForScope, setSecret } from '../security/vault.js'
import { registerSecret } from '../security/redact.js'
import { loadConfig, persistConfig } from '../config/config.js'
import { askHidden } from '../mcp/connectors-cli.js'
import { gatewayFile, pairingStatus, startPairing, unpair, type AgentPort } from './chat-bridge.js'
import { GATEWAY_PROVIDERS, findGateway } from './providers.js'
import { makeGatewayControl } from './controller.js'

const OWNER = { kind: 'owner' } as const

/** Every gateway secret: the environment first, then the vault. Never logged, never sent to a screen. */
export async function gatewaySecrets(): Promise<Record<string, string>> {
  const names = GATEWAY_PROVIDERS.flatMap((p) => p.secrets.map((s) => s.name))
  const vault = await getSecretsForScope('global').catch(() => ({}) as Record<string, string>)
  const out: Record<string, string> = {}
  for (const n of names) {
    const v = process.env[n]?.trim() || vault[n]?.trim()
    if (v) out[n] = v
  }
  return out
}

export async function saveGatewaySecret(name: string, value: string): Promise<void> {
  await setSecret(name, value)
  registerSecret(value, name)
}

/** The host seen as the bridge's port: the owner's own principal, so the usual permissions and approvals apply. */
export function hostAgentPort(host: VaraHost): AgentPort {
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: string }): T => {
    if (!r.ok) throw new Error(r.error)
    return r.value
  }
  return {
    async create(message) {
      return must(await host.create(OWNER, { message, kind: 'auto' })).id
    },
    async send(id, text) {
      must(await host.send(OWNER, id, text))
    },
    async pause(id) {
      await host.pause(OWNER, id)
    },
    async undo(id) {
      const r = await host.undo(OWNER, id, 1)
      if (!r.ok) return r.error
      const lines = [...r.value.restored.map((x) => `${x.path}: ${x.what}`), ...r.value.failed.map((x) => `${x.path}: ${x.why}`)]
      return lines.length ? lines.join('\n') : 'Nothing to undo.'
    },
    async resolveApproval(id, approvalId, approved) {
      await host.resolveApproval(OWNER, id, approvalId, approved)
    },
    async watch(id, events) {
      // After a huge id: nothing from the past is replayed, only what happens from now on.
      const sub = must(
        await host.subscribe(OWNER, id, Number.MAX_SAFE_INTEGER, {
          send: ({ event }) => {
            const e = event as unknown as Record<string, unknown>
            if (e['type'] === 'text' && typeof e['delta'] === 'string') events.onText(e['delta'])
            else if (e['type'] === 'state') events.onState(String(e['state']), typeof e['reason'] === 'string' ? e['reason'] : undefined)
            else if (e['type'] === 'approval_request') events.onApproval(e['request'] as { id: string; title: string; detail: string })
            else if (e['type'] === 'completed' && typeof e['summary'] === 'string') events.onCompleted(e['summary'])
          },
          close: () => {},
        }),
      )
      return sub.unsubscribe
    },
  }
}

export function hostGateway(host: VaraHost, config: () => import('../config/config.js').VaraConfig, log: (l: string) => void) {
  return makeGatewayControl({ config, secrets: gatewaySecrets, saveSecret: saveGatewaySecret, agent: () => hostAgentPort(host), log })
}

/** `vara gateway [list | <platform> setup | pair | unpair | status]` */
export async function gatewayCommand(args: string[]): Promise<void> {
  const ids = GATEWAY_PROVIDERS.map((p) => p.id).join(' | ')
  const [id, action = 'status'] = args
  if (!id || id === 'list') {
    const have = await gatewaySecrets()
    const cfg = await loadConfig()
    for (const p of GATEWAY_PROVIDERS) {
      const pair = await pairingStatus(gatewayFile(p.id))
      const on = (cfg.gateway as Record<string, { enabled: boolean }>)[p.id]?.enabled
      console.log(`${p.id.padEnd(9)} ${p.secrets.every((s) => have[s.name]) ? 'token set' : 'no token '}  ${on ? 'on ' : 'off'}  ${pair.paired ? 'paired' : 'not paired'}   ${p.intro.en}`)
    }
    console.log(`\nSet one up: vara gateway <${ids}> setup   (or Settings → Gateways in the browser)`)
    return
  }
  const p = findGateway(id)
  if (!p || !['setup', 'pair', 'unpair', 'status'].includes(action)) {
    console.log(`usage: vara gateway [list] | <${ids}> setup | pair | unpair | status`)
    return
  }
  const file = gatewayFile(p.id)
  if (action === 'unpair') {
    await unpair(file)
    console.log(`${p.name} chat disconnected.`)
    return
  }
  const have = await gatewaySecrets()
  if (action === 'setup') {
    p.steps.forEach((s, i) => console.log(`${i + 1}. ${s.en}`))
    const given: Record<string, string> = {}
    for (const s of p.secrets) {
      const v = await askHidden(`${s.label.en} (not shown${have[s.name] ? ', Enter keeps the saved one' : ''}): `)
      if (v) given[s.name] = v
    }
    try {
      const next = { ...have, ...given }
      for (const s of p.secrets) {
        if (!next[s.name]) return void console.log(`${s.label.en} is needed.`)
        if (given[s.name] && !s.pattern.test(given[s.name]!)) return void console.log(`${s.label.en} does not look right.`)
      }
      const bot = await p.verify(next)
      for (const [k, v] of Object.entries(given)) await saveGatewaySecret(k, v)
      const cfg = await loadConfig()
      await persistConfig({ ...cfg, gateway: { ...cfg.gateway, [p.id]: { enabled: true } } })
      const { code, minutes } = await startPairing(file)
      console.log(`Connected as ${bot}; ${p.name} is switched on.\nNow start VARA as a host (vara serve, or vara ui) and send the bot, in a direct message:  pair ${code}\nThe code works once and expires in ${minutes} minutes. A host that is already running: Settings → Gateways in its web page, or restart it.`)
    } catch (err) {
      console.log(`${p.name} did not accept that: ${(err as Error).message}`)
    }
    return
  }
  if (action === 'pair') {
    if (!p.secrets.every((s) => have[s.name])) return void console.log(`No ${p.name} token yet: vara gateway ${p.id} setup`)
    const { code, minutes } = await startPairing(file)
    console.log(`In a direct message to your ${p.name} bot send:  pair ${code}\nThe code works once and expires in ${minutes} minutes. The host must be running (vara serve / vara ui).`)
    return
  }
  const cfg = await loadConfig()
  const pair = await pairingStatus(file)
  console.log(`${p.name} — token: ${p.secrets.every((s) => have[s.name]) ? 'set' : 'not set'} · switched on: ${(cfg.gateway as Record<string, { enabled: boolean }>)[p.id]?.enabled ? 'yes' : 'no'} · chat: ${pair.paired ? 'paired' : pair.code ? `waiting for "pair ${pair.code}"` : 'not paired'}`)
}
