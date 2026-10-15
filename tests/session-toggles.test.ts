import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { makeSessionRunner } from '../src/core/runner-factory.js'
import { BUILTIN_SKILLS } from '../src/core/builtin-skills.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { AccessStore, PRESETS, type Principal } from '../src/server/access.js'
import { VaraHost } from '../src/server/host.js'
import { makeAdminPort } from '../src/core/selfmanage.js'

const fixture = join(process.cwd(), 'tests', 'fixtures', 'mcp-server.mjs')

class Spy implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    const turn: AssistantTurn = { content: 'done', toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify({ question: 'anything else, please?' }) }] }
    yield { type: 'done', result: turn }
  }
}

let dir: string
let work: string
const hubs: McpHub[] = []
const owner: Principal = { kind: 'owner' }
const skill = BUILTIN_SKILLS[0]!.name

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'vara-tg-'))
  work = await mkdtemp(join(tmpdir(), 'vara-tgw-'))
})
afterAll(async () => {
  for (const h of hubs) h.closeAll()
  await rm(dir, { recursive: true, force: true })
  await rm(work, { recursive: true, force: true })
})

const mkSession = () => createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'do a thing', acceptance: ['x'], cwd: work, auto: false }), DEFAULT_CONFIG)

describe('hub exclusion', () => {
  it('leaves out the tools and the summary line of switched-off servers', async () => {
    const hub = new McpHub()
    hubs.push(hub)
    await hub.sync({ one: { command: process.execPath, args: [fixture] }, two: { command: process.execPath, args: [fixture] } })
    expect(hub.tools().map((t) => t.name)).toContain('mcp__one__echo')
    const names = hub.tools(new Set(['one'])).map((t) => t.name)
    expect(names).not.toContain('mcp__one__echo')
    expect(names).toContain('mcp__two__echo')
    expect(hub.summary(new Set(['one']))).not.toMatch(/^- one/m)
    expect(hub.summary(new Set(['one']))).toMatch(/^- two/m)
  })
})

describe('a session can switch skills and servers off for itself only', () => {
  it('the model is not told about a skill the session switched off, nor given its server tools', async () => {
    const hub = new McpHub()
    hubs.push(hub)
    await hub.sync({ one: { command: process.execPath, args: [fixture] } })
    const config: VaraConfig = { ...DEFAULT_CONFIG }
    const run = async (mutate: (s: ReturnType<typeof mkSession>) => void) => {
      const s = mkSession()
      mutate(s)
      const provider = new Spy()
      await makeSessionRunner({ session: s, provider: () => provider, config: () => config, hub, onEvent: () => {} }).start()
      const req = provider.requests[0]!
      return { system: req.system, tools: (req.tools as Array<{ function: { name: string } }>).map((t) => t.function.name) }
    }
    const normal = await run(() => {})
    expect(normal.system).toContain(`- ${skill}:`)
    expect(normal.tools).toContain('mcp__one__echo')

    const off = await run((s) => {
      s.config.disabledSkills = [skill]
      s.config.disabledMcp = ['one']
    })
    expect(off.system).not.toContain(`- ${skill}:`)
    expect(off.tools).not.toContain('mcp__one__echo')

    // …and the next session is untouched.
    expect((await run(() => {})).system).toContain(`- ${skill}:`)
  })

  it('the admin port toggles an MCP server for the session without touching the config', async () => {
    let cfg: VaraConfig = { ...DEFAULT_CONFIG, mcp: { servers: { docs: { command: 'x', args: [], env: {}, secretEnv: [], headers: {}, enabled: true } } } }
    const s = mkSession()
    const p = makeAdminPort({ session: s, config: () => cfg, apply: async (n) => void (cfg = n) })
    await p.mcp('disable', 'docs', undefined, 'session')
    expect(s.config.disabledMcp).toEqual(['docs'])
    expect(cfg.mcp.servers['docs']!.enabled).toBe(true)
    await p.mcp('enable', 'docs', undefined, 'session')
    expect(s.config.disabledMcp).toEqual([])
    await expect(p.mcp('enable', 'ghost', undefined, 'session')).rejects.toThrow(/No MCP server/)
  })
})

describe('toggles through the host', () => {
  it('the owner switches things for one session; the view shows it; a guest cannot', async () => {
    const config: VaraConfig = { ...DEFAULT_CONFIG, mcp: { servers: { docs: { command: 'x', args: [], env: {}, secretEnv: [], headers: {}, enabled: true } } } }
    const access = new AccessStore(join(dir, 'host'))
    const host = new VaraHost({ config: () => config, provider: () => new Spy(), hub: new McpHub(), access, cwd: work })
    try {
      const made = await host.create(owner, { message: 'hello there friend', kind: 'task' })
      if (!made.ok) throw new Error(made.error)
      const id = made.value.id
      expect((await host.setToggle(owner, id, 'skill', skill, false)).ok).toBe(true)
      expect((await host.setToggle(owner, id, 'mcp', 'docs', false)).ok).toBe(true)
      expect((await host.setToggle(owner, id, 'mcp', 'ghost', false)).ok).toBe(false)
      expect((await host.setToggle(owner, id, 'skill', 'ghost-skill', false)).ok).toBe(false)
      let v = await host.get(owner, id)
      expect(v.ok && [v.value.disabledSkills, v.value.disabledMcp]).toEqual([[skill], ['docs']])
      expect((await host.setToggle(owner, id, 'skill', skill, true)).ok).toBe(true)
      v = await host.get(owner, id)
      expect(v.ok && v.value.disabledSkills).toEqual([])

      const inv = access.createInvite({ ...PRESETS.collaborator, ownSession: true })
      const joined = access.redeem(inv.token, 'Sam')
      if ('error' in joined) throw new Error(joined.error)
      expect((await host.setToggle(joined.guest, id, 'skill', skill, false)).ok).toBe(false)
    } finally {
      await host.closeAll()
    }
  })
})
