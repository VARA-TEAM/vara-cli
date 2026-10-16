import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { makeGatewayControl } from '../src/gateway/controller.js'
import { GATEWAY_PROVIDERS } from '../src/gateway/providers.js'
import { pairingStatus, startPairing, unpair, type AgentPort } from '../src/gateway/chat-bridge.js'

const TG = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
// Built at run time: a literal token-shaped string trips GitHub's secret scanning even when it is a fake.
const SLACK_BOT = ['xoxb', '1234567890', 'abcdefghijklmnop'].join('-')
const SLACK_APP = ['xapp', '1', 'A0123456789', 'abcdefghijklmnop'].join('-')
let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-gwc-'))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const fakeNet = (async (url: unknown) => {
  const u = String(url)
  const ok = (r: unknown) => new Response(JSON.stringify(r), { status: 200 })
  if (u.includes(TG) && u.endsWith('/getMe')) return ok({ ok: true, result: { id: 1, username: 'vara_test_bot' } })
  if (u.endsWith('/auth.test')) return ok({ ok: true, user: 'varabot', team: 'Acme' })
  if (u.endsWith('/users/@me')) return ok({ id: '9', username: 'VaraBot' })
  return new Response(JSON.stringify({ ok: false, description: 'Unauthorized', error: 'invalid_auth' }), { status: 401 })
}) as unknown as typeof fetch

function rig() {
  const vault: Record<string, string> = {}
  let cfg: VaraConfig = DEFAULT_CONFIG
  const started: string[] = []
  const stopped: string[] = []
  const providers = GATEWAY_PROVIDERS.map((p) => ({ ...p, start: () => (started.push(p.id), () => void stopped.push(p.id)) }))
  const gw = makeGatewayControl({
    config: () => cfg,
    secrets: async () => ({ ...vault }),
    saveSecret: async (n, v) => void (vault[n] = v),
    agent: () => ({}) as AgentPort,
    log: () => {},
    fetchImpl: fakeNet,
    providers,
    fileFor: (id) => join(dir, `${id}-${Math.random().toString(36).slice(2)}.json`),
  })
  const enable = (id: string, on: boolean) => void (cfg = { ...cfg, gateway: { ...cfg.gateway, [id]: { enabled: on } } })
  return { gw, vault, started, stopped, enable }
}

describe('gateway control (several platforms)', () => {
  it('lists every platform with what it needs, and never a stored value', async () => {
    const r = rig()
    const s = await r.gw.status()
    expect(s.providers.map((p) => p.id)).toEqual(['telegram', 'discord', 'slack'])
    expect(s.providers.find((p) => p.id === 'slack')!.fields.map((f) => f.name)).toEqual(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])
    await r.gw.setSecrets('telegram', { TELEGRAM_BOT_TOKEN: TG })
    expect(JSON.stringify(await r.gw.status())).not.toContain(TG)
  })

  it('checks tokens with the platform before keeping them; a half-filled platform is not accepted', async () => {
    const r = rig()
    await expect(r.gw.setSecrets('telegram', { TELEGRAM_BOT_TOKEN: 'nope' })).rejects.toThrow(/does not look right/)
    await expect(r.gw.setSecrets('telegram', { TELEGRAM_BOT_TOKEN: '999999999:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123' })).rejects.toThrow(/did not accept/)
    await expect(r.gw.setSecrets('slack', { SLACK_BOT_TOKEN: SLACK_BOT })).rejects.toThrow(/Still needed/)
    expect(Object.keys(r.vault)).toEqual([])
    expect((await r.gw.setSecrets('slack', { SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: SLACK_APP })).bot).toBe('varabot (Acme)')
    expect(Object.keys(r.vault).sort()).toEqual(['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN'])
  })

  it('platforms are independent: the person turns on only the ones they use', async () => {
    const r = rig()
    await r.gw.setSecrets('telegram', { TELEGRAM_BOT_TOKEN: TG })
    await r.gw.setSecrets('slack', { SLACK_BOT_TOKEN: SLACK_BOT, SLACK_APP_TOKEN: SLACK_APP })
    expect(r.started).toEqual([]) // tokens alone start nothing
    r.enable('telegram', true)
    await r.gw.reconcile()
    expect(r.started).toEqual(['telegram'])
    r.enable('slack', true)
    await r.gw.reconcile()
    expect(r.started).toEqual(['telegram', 'slack'])
    r.enable('telegram', false)
    await r.gw.reconcile()
    expect(r.stopped).toEqual(['telegram'])
    expect((await r.gw.status()).providers.map((p) => [p.id, p.running])).toEqual([['telegram', false], ['discord', false], ['slack', true]])
    // replacing a token restarts only that platform
    await r.gw.setSecrets('slack', { SLACK_BOT_TOKEN: SLACK_BOT })
    expect(r.started.filter((x) => x === 'slack')).toHaveLength(2)
    r.gw.stop()
    expect(r.stopped).toContain('slack')
  })

  it('pairing needs the platform\'s tokens first; the code shows in the status until used or expired', async () => {
    const r = rig()
    await expect(r.gw.pair('discord')).rejects.toThrow(/token first/)
    await expect(r.gw.pair('matrix')).rejects.toThrow(/Unknown gateway/)
    const file = join(dir, 'pairing.json')
    const { code } = await startPairing(file)
    expect((await pairingStatus(file)).code).toBe(code)
    expect((await pairingStatus(file, () => Date.now() + 11 * 60_000)).code).toBeUndefined()
    await unpair(file)
    expect(await pairingStatus(file)).toEqual({ paired: false })
  })
})
