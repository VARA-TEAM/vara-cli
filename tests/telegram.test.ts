import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chunk, TelegramApi, type TgUpdate } from '../src/gateway/telegram-api.js'
import { startPairing, TelegramBridge, type AgentEvents, type AgentPort, type Messenger } from '../src/gateway/telegram-bridge.js'

let dir: string
let file: string
let clock = 1_000_000
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-tg-'))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

const msg = (chatId: number, text: string, type = 'private'): TgUpdate => ({ update_id: 1, message: { message_id: 1, text, chat: { id: chatId, type } } })

function rig() {
  const sent: Array<{ chat: number; text: string; buttons?: unknown }> = []
  const answered: string[] = []
  const calls: string[] = []
  let events: AgentEvents | null = null
  const tg: Messenger = {
    async sendMessage(chat, text, buttons) {
      sent.push({ chat, text, buttons })
    },
    async answerCallback(_id, text) {
      answered.push(text ?? '')
    },
  }
  const agent: AgentPort = {
    async create(m) {
      calls.push(`create:${m}`)
      return 'sess1'
    },
    async send(id, t) {
      calls.push(`send:${id}:${t}`)
    },
    async pause(id) {
      calls.push(`pause:${id}`)
    },
    async undo() {
      return 'a.txt: restored'
    },
    async resolveApproval(id, a, ok) {
      calls.push(`approve:${id}:${a}:${ok}`)
    },
    async watch(_id, e) {
      events = e
      return () => {}
    },
  }
  file = join(dir, `state-${Math.random().toString(36).slice(2)}.json`)
  return { bridge: new TelegramBridge(tg, agent, file, () => clock), sent, answered, calls, events: () => events! }
}

describe('Telegram bridge — who may talk to it', () => {
  it('ignores strangers completely, pairs with the one-time code, and then only that chat is served', async () => {
    const r = rig()
    await r.bridge.handle(msg(7, 'hello'))
    await r.bridge.handle(msg(7, '/pair WRONGCODE'))
    expect(r.sent).toEqual([])
    const { code } = await startPairing(file, () => clock)
    await r.bridge.handle(msg(8, `/pair ${code}`, 'group')) // groups never pair
    expect(r.sent).toEqual([])
    await r.bridge.handle(msg(7, `/pair ${code}`))
    expect(r.sent[0]!.text).toMatch(/Paired/)
    // the code was one-time
    await r.bridge.handle(msg(9, `/pair ${code}`))
    expect(r.sent).toHaveLength(1)
    // another chat is still ignored; the paired one is served
    await r.bridge.handle(msg(9, 'do something'))
    expect(r.calls).toEqual([])
    await r.bridge.handle(msg(7, 'fix the bug'))
    expect(r.calls).toEqual(['create:fix the bug'])
  })

  it('an expired code does not pair, and five wrong codes lock pairing for the hour', async () => {
    const r = rig()
    const { code } = await startPairing(file, () => clock)
    clock += 11 * 60_000
    await r.bridge.handle(msg(7, `/pair ${code}`))
    expect(r.sent).toEqual([])
    const fresh = await startPairing(file, () => clock)
    for (let i = 0; i < 5; i++) await r.bridge.handle(msg(7, `/pair BADBAD0${i}`))
    await r.bridge.handle(msg(7, `/pair ${fresh.code}`))
    expect(r.sent).toEqual([])
  })
})

describe('Telegram bridge — talking to the agent', () => {
  async function paired() {
    const r = rig()
    const { code } = await startPairing(file, () => clock)
    await r.bridge.handle(msg(7, `/pair ${code}`))
    r.sent.length = 0
    return r
  }

  it('sends the agent\'s answer when its turn ends, continues the same session, and /new starts another', async () => {
    const r = await paired()
    await r.bridge.handle(msg(7, 'what is in src?'))
    r.events().onText('Two files: a.ts and b.ts.')
    r.events().onState('ready')
    await new Promise((x) => setTimeout(x, 10))
    expect(r.sent.at(-1)!.text).toBe('Two files: a.ts and b.ts.')
    await r.bridge.handle(msg(7, 'and tests?'))
    expect(r.calls).toEqual(['create:what is in src?', 'send:sess1:and tests?'])
    await r.bridge.handle(msg(7, '/new'))
    await r.bridge.handle(msg(7, 'fresh start'))
    expect(r.calls.at(-1)).toBe('create:fresh start')
  })

  it('asks for approval with buttons, and only the paired chat can answer', async () => {
    const r = await paired()
    await r.bridge.handle(msg(7, 'install the thing'))
    r.events().onApproval({ id: 'ap1', title: 'Add an MCP server', detail: 'command: npx x' })
    await new Promise((x) => setTimeout(x, 10))
    const ask = r.sent.at(-1)!
    expect(ask.text).toMatch(/Add an MCP server/)
    expect(JSON.stringify(ask.buttons)).toContain('a:sess1:ap1:1')
    // a stranger's tap does nothing
    await r.bridge.handle({ update_id: 2, callback_query: { id: 'c1', data: 'a:sess1:ap1:1', from: { id: 99 }, message: { chat: { id: 99 }, message_id: 5 } } })
    expect(r.calls.some((c) => c.startsWith('approve'))).toBe(false)
    // the owner's tap does
    await r.bridge.handle({ update_id: 3, callback_query: { id: 'c2', data: 'a:sess1:ap1:0', from: { id: 7 }, message: { chat: { id: 7 }, message_id: 5 } } })
    expect(r.calls).toContain('approve:sess1:ap1:false')
  })

  it('/stop pauses, /undo reports, /unpair forgets the chat', async () => {
    const r = await paired()
    await r.bridge.handle(msg(7, 'work'))
    await r.bridge.handle(msg(7, '/stop'))
    await r.bridge.handle(msg(7, '/undo'))
    expect(r.calls).toContain('pause:sess1')
    expect(r.sent.at(-1)!.text).toBe('a.txt: restored')
    await r.bridge.handle(msg(7, '/unpair'))
    const before = r.calls.length
    await r.bridge.handle(msg(7, 'still there?'))
    expect(r.calls.length).toBe(before)
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({})
  })
})

describe('Telegram API client', () => {
  it('splits long answers at line breaks', () => {
    const long = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(20)}`).join('\n')
    const parts = chunk(long)
    expect(parts.length).toBeGreaterThan(1)
    expect(parts.every((p) => p.length <= 3800)).toBe(true)
    expect(parts.join('\n').replace(/\s+/g, '')).toBe(long.replace(/\s+/g, ''))
  })

  it('never puts the bot token in an error message', async () => {
    const api = new TelegramApi('123:SECRET-TOKEN', (async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 })) as unknown as typeof fetch)
    await expect(api.sendMessage(1, 'hi')).rejects.toThrow(/Unauthorized/)
    await expect(api.sendMessage(1, 'hi')).rejects.not.toThrow(/SECRET-TOKEN/)
  })
})
