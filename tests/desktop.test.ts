import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toSendKeys, type DesktopDriver } from '../src/desktop/driver.js'
import { ActionBudget, fitSize, isSensitiveWindow, keyAllowed, needsPaste, pngSize, toScreen } from '../src/desktop/policy.js'
import { forgetDesktop, killDesktop, makeDesktopTool } from '../src/tools/desktop-tool.js'
import type { ToolContext } from '../src/tools/types.js'

describe('desktop policy (pure)', () => {
  it('maps screenshot coordinates to screen pixels and clamps to the screen', () => {
    const shot = { width: 1280, height: 720, scale: 1.5 } // a 1920x1080 screen shown at 1280 wide
    expect(toScreen(640, 360, shot)).toEqual({ x: 960, y: 540 })
    expect(toScreen(5000, 5000, shot)).toEqual({ x: 1919, y: 1079 })
    expect(toScreen(-5, -5, shot)).toEqual({ x: 0, y: 0 })
    expect(fitSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720, scale: 1.5 })
    expect(fitSize(1000, 600, 1280)).toEqual({ width: 1000, height: 600, scale: 1 })
  })

  it('refuses to act in password, bank and sign-in windows', () => {
    for (const t of ['Bitwarden', '1Password — Vault', 'Sign in to your account', 'Windows Security', 'User Account Control', 'MetaMask']) expect(isSensitiveWindow(t), t).toBe(true)
    for (const t of ['Untitled - Notepad', 'main.ts - Visual Studio Code', 'Calculator']) expect(isSensitiveWindow(t), t).toBe(false)
  })

  it('never sends keys that leave the app', () => {
    expect(keyAllowed('ctrl+s').ok).toBe(true)
    expect(keyAllowed('Enter').ok).toBe(true)
    expect(keyAllowed('Ctrl+Alt+Delete').ok).toBe(false)
    expect(keyAllowed('Win+R').ok).toBe(false)
    expect(keyAllowed('cmd+l').ok).toBe(false)
    expect(keyAllowed('alt+f4').ok).toBe(false)
    expect(keyAllowed('').ok).toBe(false)
  })

  it('pastes long or non-ASCII text, types the rest; converts combos to SendKeys', () => {
    expect(needsPaste('hello')).toBe(false)
    expect(needsPaste('مرحبا')).toBe(true)
    expect(needsPaste('x'.repeat(201))).toBe(true)
    expect(toSendKeys('ctrl+s')).toBe('^s')
    expect(toSendKeys('ctrl+shift+Tab')).toBe('^+{TAB}')
    expect(toSendKeys('alt+F4')).toBe('%{F4}')
    expect(toSendKeys('enter')).toBe('{ENTER}')
    expect(() => toSendKeys('ctrl+banana')).toThrow()
  })

  it('has an action budget per minute and per session', () => {
    const b = new ActionBudget(5, 3)
    expect([b.take(0).ok, b.take(1).ok, b.take(2).ok, b.take(3).ok]).toEqual([true, true, true, false])
    expect(b.take(61_000).ok).toBe(true)
    const small = new ActionBudget(2, 10)
    small.take(0)
    small.take(1)
    expect(small.take(2)).toMatchObject({ ok: false, reason: expect.stringContaining('2 desktop actions') })
  })

  it('reads a PNG size from its header', () => {
    const b = Buffer.alloc(32)
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b)
    b.writeUInt32BE(1280, 16)
    b.writeUInt32BE(720, 20)
    expect(pngSize(b)).toEqual({ width: 1280, height: 720 })
    expect(pngSize(Buffer.from('nope'))).toBeNull()
  })
})

function fakeDriver(title = 'Untitled - Notepad') {
  const calls: string[] = []
  const d: DesktopDriver = {
    name: 'fake',
    async screenshot() {
      calls.push('screenshot')
      return { png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5, 0, 0, 0, 2, 0xd0]), shot: { width: 1280, height: 720, scale: 1.5 } }
    },
    click: async (x, y, b, dbl) => void calls.push(`click ${x},${y} ${b ?? 'left'}${dbl ? ' double' : ''}`),
    move: async (x, y) => void calls.push(`move ${x},${y}`),
    drag: async (a, b, c, e) => void calls.push(`drag ${a},${b}->${c},${e}`),
    type: async (t) => void calls.push(`type ${t}`),
    key: async (k) => void calls.push(`key ${k}`),
    scroll: async (dy) => void calls.push(`scroll ${dy}`),
    activeWindowTitle: async () => title,
  }
  return { d, calls, setTitle: (t: string) => (title = t) }
}

describe('desktop tool (fake driver — real OS control is never driven from tests)', () => {
  let dir: string
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'vara-desk-'))
  })
  afterAll(async () => rm(dir, { recursive: true, force: true }))
  const ctx = (id: string, approve?: ToolContext['approve']): ToolContext => ({ cwd: dir, mode: 'build', sessionId: id, scope: `session:${id}`, env: {}, allowPublish: false, ...(approve ? { approve } : {}) })

  it('needs approval first, and nobody to approve means no desktop', async () => {
    const f = fakeDriver()
    const tool = makeDesktopTool(() => f.d)
    const none = await tool.execute({ action: 'screenshot' }, ctx('d1'))
    expect(none.ok).toBe(false)
    expect(none.output).toContain('nobody is here')
    expect(f.calls).toEqual([])
    const no = await tool.execute({ action: 'screenshot' }, ctx('d1', async () => ({ approved: false })))
    expect(no.ok).toBe(false)
    expect(f.calls).toEqual([])
    let asked = 0
    const yes = await tool.execute({ action: 'screenshot' }, ctx('d1', async () => (asked++, { approved: true })))
    expect(yes.ok).toBe(true)
    expect(yes.images?.[0]).toMatch(/^<image id=/)
    // approved once per session: the second call does not ask again
    await tool.execute({ action: 'screenshot' }, ctx('d1', async () => (asked++, { approved: true })))
    expect(asked).toBe(1)
    forgetDesktop('d1')
  })

  it('scales model coordinates to the real screen and sends a screenshot after each action', async () => {
    const f = fakeDriver()
    const tool = makeDesktopTool(() => f.d)
    const approve = async () => ({ approved: true })
    expect((await tool.execute({ action: 'click', x: 100, y: 100 }, ctx('d2', approve))).output).toContain('take a screenshot first')
    await tool.execute({ action: 'screenshot' }, ctx('d2', approve))
    const r = await tool.execute({ action: 'double_click', x: 640, y: 360 }, ctx('d2', approve))
    expect(r.ok).toBe(true)
    expect(r.images).toHaveLength(1)
    expect(f.calls).toContain('click 960,540 left double')
    await tool.execute({ action: 'type', text: 'hello' }, ctx('d2', approve))
    await tool.execute({ action: 'key', combo: 'ctrl+s' }, ctx('d2', approve))
    expect((await tool.execute({ action: 'key', combo: 'win+r' }, ctx('d2', approve))).ok).toBe(false)
    expect(f.calls).toContain('type hello')
    expect(f.calls).toContain('key ctrl+s')
    expect(f.calls).not.toContain('key win+r')
    forgetDesktop('d2')
  })

  it('does nothing while a sensitive window is in front', async () => {
    const f = fakeDriver('Bitwarden')
    const tool = makeDesktopTool(() => f.d)
    const approve = async () => ({ approved: true })
    await tool.execute({ action: 'screenshot' }, ctx('d3', approve)) // looking is allowed
    const r = await tool.execute({ action: 'type', text: 'secret' }, ctx('d3', approve))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('password, bank or sign-in')
    expect(f.calls).not.toContain('type secret')
    forgetDesktop('d3')
  })

  it('the kill switch cancels the next action', async () => {
    const f = fakeDriver()
    const tool = makeDesktopTool(() => f.d)
    const approve = async () => ({ approved: true })
    await tool.execute({ action: 'screenshot' }, ctx('d4', approve))
    killDesktop('d4')
    const r = await tool.execute({ action: 'click', x: 1, y: 1 }, ctx('d4', approve))
    expect(r.ok).toBe(false)
    expect(r.output).toContain('stopped by the user')
    expect(f.calls.filter((c) => c.startsWith('click'))).toEqual([])
    forgetDesktop('d4')
  })
})
