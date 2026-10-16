import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { makeGatewayControl } from '../src/gateway/controller.js'
import { pairingStatus, startPairing, unpair } from '../src/gateway/telegram-bridge.js'

const GOOD = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw'
let dir: string
let file: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-gwc-'))
  file = join(dir, 'telegram.json')
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const fakeTelegram = (async (url: unknown) => {
  const u = String(url)
  if (u.includes(GOOD) && u.endsWith('/getMe')) return new Response(JSON.stringify({ ok: true, result: { id: 1, username: 'vara_test_bot' } }), { status: 200 })
  return new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })
}) as unknown as typeof fetch

function rig() {
  let stored: string | null = null
  let enabled = false
  const started: string[] = []
  let stops = 0
  const config = (): VaraConfig => ({ ...DEFAULT_CONFIG, gateway: { telegram: { enabled } } })
  const gw = makeGatewayControl({
    config,
    token: async () => stored,
    saveToken: async (t) => void (stored = t),
    start: (t) => (started.push(t), () => void stops++),
    fetchImpl: fakeTelegram,
  })
  return { gw, setEnabled: (v: boolean) => void (enabled = v), started, stops: () => stops, stored: () => stored }
}

describe('gateway control', () => {
  it('checks the token with Telegram before keeping it, and never starts without it', async () => {
    const r = rig()
    await expect(r.gw.setToken('not a token')).rejects.toThrow(/does not look like/)
    await expect(r.gw.setToken('999999999:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123')).rejects.toThrow(/did not accept/)
    expect(r.stored()).toBeNull()
    r.setEnabled(true)
    await r.gw.reconcile()
    expect(r.started).toEqual([]) // switched on but no token: nothing runs
    const ok = await r.gw.setToken(GOOD)
    expect(ok.bot).toBe('@vara_test_bot')
    expect(r.stored()).toBe(GOOD)
    expect(r.started).toEqual([GOOD]) // started at once, no restart
  })

  it('switching it off stops the bridge, on starts it, and the status never shows the token', async () => {
    const r = rig()
    await r.gw.setToken(GOOD)
    r.setEnabled(true)
    await r.gw.reconcile()
    expect((await r.gw.status()).telegram).toMatchObject({ hasToken: true, enabled: true, running: true })
    r.setEnabled(false)
    await r.gw.reconcile()
    expect(r.stops()).toBeGreaterThan(0)
    const s = await r.gw.status()
    expect(s.telegram.running).toBe(false)
    expect(JSON.stringify(s)).not.toContain(GOOD)
  })

  it('pairing needs a token first; the code shows in the status until it is used or expires', async () => {
    const r = rig()
    await expect(r.gw.pair()).rejects.toThrow(/token first/)
    // the file-level helpers the screens rely on
    const { code } = await startPairing(file)
    expect((await pairingStatus(file)).code).toBe(code)
    expect((await pairingStatus(file, () => Date.now() + 11 * 60_000)).code).toBeUndefined()
    await unpair(file)
    expect(await pairingStatus(file)).toEqual({ paired: false })
  })
})
