import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ChatBridge, startPairing, type AgentPort, type Incoming, type Platform, type Tap } from '../src/gateway/chat-bridge.js'
import { DiscordApi, DiscordGateway, type SocketLike } from '../src/gateway/discord.js'
import { handleEnvelope, SlackApi } from '../src/gateway/slack.js'

let dir: string
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-gwp-'))
})
afterAll(() => rm(dir, { recursive: true, force: true }))

/** A bridge stand-in that records what the platform adapters hand it. */
const recorder = () => {
  const messages: Incoming[] = []
  const taps: Tap[] = []
  return { messages, taps, bridge: { handleMessage: async (m: Incoming) => void messages.push(m), handleTap: async (t: Tap) => void taps.push(t) } as unknown as ChatBridge }
}

const fakeSocket = () => {
  const sent: string[] = []
  const ws: SocketLike = { send: (d) => void sent.push(d), close: () => {}, onopen: null, onmessage: null, onclose: null, onerror: null }
  return { ws, sent }
}

describe('Discord', () => {
  it('says hello properly: identifies for direct messages only, and heartbeats with the last sequence number', () => {
    const { bridge } = recorder()
    const { ws, sent } = fakeSocket()
    const g = new DiscordGateway('TOKEN', bridge, () => {}, () => ws)
    g.frame(JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }), ws)
    const id = JSON.parse(sent[0]!) as { op: number; d: { token: string; intents: number } }
    expect(id.op).toBe(2)
    expect(id.d.token).toBe('TOKEN')
    expect(id.d.intents).toBe(1 << 12) // DIRECT_MESSAGES, nothing privileged
    g.frame(JSON.stringify({ op: 0, s: 7, t: 'READY', d: { user: { id: 'BOT' } } }), ws)
    g.frame(JSON.stringify({ op: 1 }), ws)
    expect(JSON.parse(sent.at(-1)!)).toEqual({ op: 1, d: 7 })
    g.start()() // stop before it connects anywhere
  })

  it('passes a person\'s direct message on, and ignores bots, itself and server channels (via the bridge flag)', () => {
    const r = recorder()
    const { ws } = fakeSocket()
    const g = new DiscordGateway('T', r.bridge, () => {}, () => ws)
    g.frame(JSON.stringify({ op: 0, s: 1, t: 'READY', d: { user: { id: 'BOT' } } }), ws)
    const msg = (extra: Record<string, unknown>) => JSON.stringify({ op: 0, s: 2, t: 'MESSAGE_CREATE', d: { channel_id: 'C1', content: 'fix it', author: { id: 'U1' }, ...extra } })
    g.frame(msg({}), ws)
    g.frame(msg({ author: { id: 'BOT' } }), ws)
    g.frame(msg({ author: { id: 'U2', bot: true } }), ws)
    g.frame(msg({ guild_id: 'G1' }), ws)
    expect(r.messages).toEqual([
      { chat: 'C1', text: 'fix it', private: true },
      { chat: 'C1', text: 'fix it', private: false }, // reaches the bridge, which drops anything not private
    ])
    g.frame(JSON.stringify({ op: 0, s: 3, t: 'INTERACTION_CREATE', d: { type: 3, id: 'I1', token: 'TK', channel_id: 'C1', data: { custom_id: 'a:s:p:1' } } }), ws)
    expect(r.taps).toEqual([{ id: 'I1/TK', chat: 'C1', data: 'a:s:p:1' }])
  })

  it('sends long text in pieces with buttons on the last, and the token never reaches an error', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = []
    const net = (async (url: unknown, init?: { body?: string }) => {
      calls.push({ url: String(url), body: init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {} })
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch
    await new DiscordApi('SECRET-TOKEN', net).send('C1', `${'line\n'.repeat(900)}`, [{ label: 'Approve', data: 'a:1' }])
    expect(calls.length).toBeGreaterThan(1)
    expect(calls[0]!.body['components']).toBeUndefined()
    expect(JSON.stringify(calls.at(-1)!.body['components'])).toContain('a:1')
    const bad = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch
    await expect(new DiscordApi('SECRET-TOKEN', bad).me()).rejects.not.toThrow(/SECRET-TOKEN/)
  })
})

describe('Slack', () => {
  const env = (payload: unknown, type = 'events_api') => JSON.stringify({ type, envelope_id: 'E1', payload })
  const dm = (extra: Record<string, unknown> = {}) => ({ event: { type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'pair ABCD1234', ...extra } })

  it('hands a person\'s direct message to the bridge and always acknowledges the envelope', () => {
    const r = recorder()
    const out = handleEnvelope(env(dm()), r.bridge, undefined)
    expect(out.ack).toBe(JSON.stringify({ envelope_id: 'E1' }))
    expect(r.messages).toEqual([{ chat: 'D1', text: 'pair ABCD1234', private: true }])
  })

  it('ignores bots, edits and joins; marks channels as not private; maps button taps; reconnects on disconnect', () => {
    const r = recorder()
    handleEnvelope(env(dm({ bot_id: 'B1' })), r.bridge, undefined)
    handleEnvelope(env(dm({ subtype: 'message_changed' })), r.bridge, undefined)
    handleEnvelope(env(dm({ channel_type: 'channel' })), r.bridge, undefined)
    expect(r.messages).toEqual([{ chat: 'D1', text: 'pair ABCD1234', private: false }])
    handleEnvelope(env({ type: 'block_actions', actions: [{ value: 'a:s:p:0' }], channel: { id: 'D1' } }, 'interactive'), r.bridge, undefined)
    expect(r.taps).toEqual([{ id: 'D1', chat: 'D1', data: 'a:s:p:0' }])
    expect(handleEnvelope(JSON.stringify({ type: 'disconnect' }), r.bridge, undefined).reconnect).toBe(true)
    expect(handleEnvelope('not json', r.bridge, undefined)).toEqual({})
  })

  it('never puts a token in an error message', async () => {
    const net = (async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), { status: 200 })) as unknown as typeof fetch
    await expect(new SlackApi('xoxb-SECRET', 'xapp-SECRET', net).authTest()).rejects.toThrow(/invalid_auth/)
    await expect(new SlackApi('xoxb-SECRET', 'xapp-SECRET', net).authTest()).rejects.not.toThrow(/SECRET/)
  })
})

describe('the shared bridge, as Slack and Discord use it', () => {
  it('pairs with "pair CODE" (no slash), takes "!" commands, and ignores a stranger and channels', async () => {
    const sent: string[] = []
    const calls: string[] = []
    const out: Platform = { send: async (_c, t) => void sent.push(t), ack: async () => {} }
    const agent = { create: async (m: string) => (calls.push(`create:${m}`), 's1'), send: async () => {}, pause: async (id: string) => void calls.push(`pause:${id}`), undo: async () => 'x', resolveApproval: async () => {}, watch: async () => () => {} } as unknown as AgentPort
    const file = join(dir, 'slackstate.json')
    const bridge = new ChatBridge(out, agent, file)
    const { code } = await startPairing(file)
    await bridge.handleMessage({ chat: 'D9', text: `pair ${code}`, private: false }) // a channel never pairs
    await bridge.handleMessage({ chat: 'D8', text: 'hello?', private: true }) // a stranger gets nothing
    expect(sent).toEqual([])
    await bridge.handleMessage({ chat: 'D1', text: `pair ${code}`, private: true })
    expect(sent[0]).toMatch(/Paired/)
    await bridge.handleMessage({ chat: 'D1', text: 'do the thing', private: true })
    await bridge.handleMessage({ chat: 'D1', text: '!stop', private: true })
    expect(calls).toEqual(['create:do the thing', 'pause:s1'])
  })
})
