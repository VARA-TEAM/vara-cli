import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AssistantTurn, Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { Engine } from '../src/core/engine.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { makeAdminPort, type AdminPort } from '../src/core/selfmanage.js'
import { policyFor } from '../src/core/modes.js'
import type { EngineEvent } from '../src/core/types.js'

class Scripted implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly script: AssistantTurn[]) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(req)
    const turn = this.script.shift() ?? { content: 'done', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) })
const ask = { content: 'ok', toolCalls: [call('z', 'ask_user', { question: 'what next, please?' })] }

let work: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'vara-self-'))
})
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
})

const session = (over: Record<string, unknown> = {}) =>
  createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'do a thing', acceptance: ['x'], cwd: work, auto: false, ...over }), DEFAULT_CONFIG)

function stubPort(log: string[]): AdminPort {
  return {
    writeSkill: async (n) => (log.push(`skill:${n}`), 'written'),
    setSkillEnabled: async (n, e, s) => (log.push(`toggle:${n}:${e}:${s}`), 'toggled'),
    mcp: async (a, n) => (log.push(`mcp:${a}:${n}`), 'mcp done'),
    setMode: async (n) => (log.push(`mode:${n}`), 'mode set'),
  }
}

/** Run an engine; answer every approval request with `answer` (or never, when null). */
async function drive(s: ReturnType<typeof session>, script: AssistantTurn[], opts: { answer: boolean | null; admin?: AdminPort; interactive?: boolean; modePolicy?: () => ReturnType<typeof policyFor> }) {
  const events: EngineEvent[] = []
  const provider = new Scripted(script)
  let engine!: Engine
  engine = new Engine({
    session: s,
    provider,
    admin: opts.admin,
    interactive: opts.interactive ?? true,
    ...(opts.modePolicy ? { modePolicy: opts.modePolicy } : {}),
    onEvent: (e) => {
      events.push(e)
      if (e.type === 'approval_request' && opts.answer !== null) setImmediate(() => engine.resolveApproval(e.request.id, opts.answer as boolean))
    },
  })
  await engine.run()
  return { events, provider, engine }
}

describe('self-management needs a yes', () => {
  it('runs the change only after the user approves, and shows the exact request', async () => {
    const log: string[] = []
    const s = session()
    const { events } = await drive(s, [{ content: '', toolCalls: [call('a', 'mcp_manage', { action: 'add', name: 'docs', command: 'npx -y @scope/docs-server' })] }, ask], { answer: true, admin: stubPort(log) })
    const req = events.find((e) => e.type === 'approval_request')
    expect(req && req.type === 'approval_request' && req.request.detail).toMatch(/npx -y @scope\/docs-server/)
    expect(log).toEqual(['mcp:add:docs'])
    expect(events.some((e) => e.type === 'approval_resolved' && e.approved)).toBe(true)
    expect(s.pendingApprovals ?? []).toEqual([])
  })

  it('a declined request changes nothing and tells the model not to retry', async () => {
    const log: string[] = []
    const s = session()
    await drive(s, [{ content: '', toolCalls: [call('a', 'skill_write', { name: 'deploy', description: 'when deploying', body: '# steps\n1. do it' })] }, ask], { answer: false, admin: stubPort(log) })
    expect(log).toEqual([])
    const r = s.transcript.find((m) => m.toolName === 'skill_write')
    expect(r?.content).toMatch(/declined/)
  })

  it('without an interactive approver nothing is changed (headless runs, never silent)', async () => {
    const log: string[] = []
    const s = session()
    await drive(s, [{ content: '', toolCalls: [call('a', 'skill_toggle', { name: 'x', enabled: false })] }, ask], { answer: null, admin: stubPort(log), interactive: false })
    expect(log).toEqual([])
    expect(s.transcript.find((m) => m.toolName === 'skill_toggle')?.content).toMatch(/nobody is here to approve/)
  })

  it('the tools are not offered at all without an admin port, nor to sub-agents', async () => {
    const s = session()
    const a = await drive(s, [ask], { answer: null })
    const names = (a.provider.requests[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).not.toContain('mcp_manage')
    expect(names).not.toContain('switch_mode')
    const s2 = session()
    const b = await drive(s2, [ask], { answer: null, admin: stubPort([]) })
    const names2 = (b.provider.requests[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names2).toEqual(expect.arrayContaining(['skill_write', 'skill_toggle', 'mcp_manage', 'switch_mode']))
  })

  it('stopping the run while a request waits declines it', async () => {
    const log: string[] = []
    const s = session()
    let engine!: Engine
    const provider = new Scripted([{ content: '', toolCalls: [call('a', 'mcp_manage', { action: 'remove', name: 'docs' })] }, ask])
    engine = new Engine({ session: s, provider, admin: stubPort(log), interactive: true, onEvent: (e) => e.type === 'approval_request' && setImmediate(() => engine.stop()) })
    await engine.run()
    expect(log).toEqual([])
    expect(s.pendingApprovals ?? []).toEqual([])
  })
})

describe('self-management respects modes', () => {
  it('plan mode: may ask to switch mode, but cannot write skills or touch MCP', async () => {
    const log: string[] = []
    const s = session({ mode: 'plan' })
    await drive(
      s,
      [
        { content: '', toolCalls: [call('a', 'skill_write', { name: 'x', description: 'when x', body: '# do x steps' }), call('b', 'switch_mode', { mode: 'build', reason: 'the plan is ready' })] },
        ask,
      ],
      { answer: true, admin: stubPort(log) },
    )
    expect(log).toEqual(['mode:build'])
    expect(s.transcript.find((m) => m.toolName === 'skill_write')?.content).toMatch(/Denied/)
  })

  it('a custom mode that does not list the tool cannot use it', async () => {
    const log: string[] = []
    const s = session()
    s.config.customMode = 'locked'
    const policy = policyFor({ locked: { description: 'no self change', base: 'build', allowTools: ['read_file'], denyTools: [], allowCommands: [], denyCommands: [] } }, 'locked')
    await drive(s, [{ content: '', toolCalls: [call('a', 'switch_mode', { mode: 'build', reason: 'escape please' })] }, ask], { answer: true, admin: stubPort(log), modePolicy: () => policy })
    expect(log).toEqual([])
  })
})

describe('the admin port', () => {
  let cfg: VaraConfig
  const port = (s = session()) => makeAdminPort({ session: s, config: () => cfg, apply: async (n) => void (cfg = n) })

  it('adds, disables and removes an MCP server in the config; refuses duplicates and bad names', async () => {
    cfg = { ...DEFAULT_CONFIG, mcp: { servers: {} } }
    const p = port()
    await p.mcp('add', 'docs', 'npx -y @scope/docs-server')
    expect(cfg.mcp.servers['docs']).toMatchObject({ command: 'npx', args: ['-y', '@scope/docs-server'], enabled: true })
    await expect(p.mcp('add', 'docs', 'npx x')).rejects.toThrow(/already exists/)
    await expect(p.mcp('add', 'bad name', 'npx x')).rejects.toThrow(/name/)
    await p.mcp('disable', 'docs')
    expect(cfg.mcp.servers['docs']!.enabled).toBe(false)
    await p.mcp('remove', 'docs')
    expect(cfg.mcp.servers['docs']).toBeUndefined()
    await expect(p.mcp('remove', 'docs')).rejects.toThrow(/No MCP server/)
  })

  it('writes a skill file with front matter and refuses a bad name or empty text', async () => {
    cfg = { ...DEFAULT_CONFIG }
    const p = port()
    const msg = await p.writeSkill('release-notes', 'when asked for a changelog', '# Steps\n1. read git log', 'project')
    expect(msg).toMatch(/Created/)
    const file = join(work, '.vara', 'skills', 'release-notes', 'SKILL.md')
    expect(existsSync(file)).toBe(true)
    expect(readFileSync(file, 'utf8')).toMatch(/^---\nname: release-notes\ndescription: when asked for a changelog\n---\n# Steps/)
    expect(await p.writeSkill('release-notes', 'v2', '# Steps v2', 'project')).toMatch(/Updated/)
    await expect(p.writeSkill('Bad Name', 'd', 'b', 'project')).rejects.toThrow(/Skill name/)
    await expect(p.writeSkill('ok', 'd', '   ', 'project')).rejects.toThrow(/empty/)
  })

  it('toggles a skill for the session or globally; unknown skills are an error', async () => {
    cfg = { ...DEFAULT_CONFIG, skills: { disabled: [] } }
    const s = session()
    const p = port(s)
    const builtin = (await import('../src/core/builtin-skills.js')).BUILTIN_SKILLS[0]!.name
    await p.setSkillEnabled(builtin, false, 'session')
    expect(s.config.disabledSkills).toEqual([builtin])
    expect(cfg.skills.disabled).toEqual([])
    await p.setSkillEnabled(builtin, true, 'session')
    expect(s.config.disabledSkills).toEqual([])
    await p.setSkillEnabled(builtin, false, 'global')
    expect(cfg.skills.disabled).toEqual([builtin])
    await expect(p.setSkillEnabled('nope-nope', false, 'session')).rejects.toThrow(/No skill/)
  })

  it('sets the mode, including a custom one, and refuses unknown names', async () => {
    cfg = { ...DEFAULT_CONFIG, modes: { review: { description: '', base: 'plan', allowTools: [], denyTools: [], allowCommands: [], denyCommands: [] } } }
    const s = session()
    const p = port(s)
    await p.setMode('review')
    expect([s.config.mode, s.config.customMode]).toEqual(['plan', 'review'])
    await p.setMode('build')
    expect([s.config.mode, s.config.customMode]).toEqual(['build', undefined])
    await expect(p.setMode('nope')).rejects.toThrow(/No mode/)
  })
})
