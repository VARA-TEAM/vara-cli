import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { McpHub } from '../src/mcp/hub.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { makeSystemPort, namesOnly, safeArgs, safeUrl, SYSTEM_TOPICS, type SystemDeps, type SystemPort } from '../src/core/systeminfo.js'
import { writeSkill } from '../src/core/skills.js'
import { registerSecret, clearSecrets, scrubSystem } from '../src/security/redact.js'
import { toolsFor } from '../src/tools/registry.js'
import { varaSystemTool, settingChangeTool, skillDeleteTool, connectorManageTool, modeManageTool } from '../src/tools/system-tools.js'
import type { ToolContext } from '../src/tools/types.js'
import type { SessionSummary } from '../src/core/store.js'
import type { Session } from '../src/core/types.js'

/** Values that must NEVER show up in anything the agent can read. */
const SECRETS = {
  apiKey: 'sk-live-ABCDEFGHIJKLMNOPQRSTUV123456',
  envValue: 'ENVSECRET-9f8e7d6c5b4a',
  header: 'Bearer HEADERSECRET1234567890abcdef',
  arg: 'ARGSECRET-1a2b3c4d5e6f',
  urlPass: 'URLPASSWORD-zz99',
  query: 'QUERYSECRET-abc123456',
  owner: 'Qm9XzT3kLw8RyVn2PdJf6HsUc1AeGb4Ni7oKxMtYrSq', // 43 chars, the shape of an owner / invite token
  registered: 'REGISTERED-secret-value-42',
  transcript: 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
}

let work: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'vara-sys-'))
})
afterAll(async () => {
  clearSecrets()
  await rm(work, { recursive: true, force: true })
})

function config(): VaraConfig {
  return {
    ...DEFAULT_CONFIG,
    providers: {
      openai: { type: 'openai', baseUrl: `https://user:${SECRETS.urlPass}@api.openai.com/v1?key=${SECRETS.query}`, apiKeySecret: 'OPENAI_API_KEY', apiKeyEnv: 'OPENAI_API_KEY', keyless: false, models: { 'gpt-4o': { status: 'ok' } } },
    },
    mcp: {
      servers: {
        docs: { command: 'npx', args: ['-y', '@scope/docs', '--token', SECRETS.arg, `--api-key=${SECRETS.arg}`], env: { DOCS_TOKEN: SECRETS.envValue }, secretEnv: ['DOCS_VAULT_TOKEN'], headers: { Authorization: SECRETS.header }, enabled: true },
        remote: { url: `https://u:${SECRETS.urlPass}@mcp.example.com/sse?token=${SECRETS.query}`, bearerSecret: 'REMOTE_TOKEN', args: [], env: {}, secretEnv: [], headers: {}, enabled: true },
      },
    },
  } as VaraConfig
}

const mk = (cwd: string, over: Record<string, unknown> = {}): Session =>
  createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'do a thing', cwd, auto: false, ...over }), DEFAULT_CONFIG)

function setup(over: Partial<SystemDeps> = {}): { port: SystemPort; applied: VaraConfig[]; session: Session; other: Session } {
  const session = mk(work)
  const other = mk(join(work, 'elsewhere'), { objective: 'the other folder job' })
  other.transcript = [
    { role: 'user', content: `please use my key ${SECRETS.apiKey} and ${SECRETS.registered}`, at: 'x' },
    { role: 'assistant', content: `ok. Authorization: ${SECRETS.header} and token=${SECRETS.owner} also ${SECRETS.transcript}`, at: 'x', toolCalls: [{ id: '1', name: 'shell', arguments: JSON.stringify({ command: `curl -H "x-api-key: ${SECRETS.apiKey}" https://x` }) }] },
    { role: 'system', content: 'SYSTEM PROMPT SHOULD NOT APPEAR', at: 'x' },
  ]
  other.evidence = [{ at: 'x', kind: 'command', command: `echo password=${SECRETS.envValue}`, output: `secret: ${SECRETS.envValue}`, ok: true, exitCode: 0 }]
  const summaries: SessionSummary[] = [session, other].map((s) => ({ id: s.id, updatedAt: s.updatedAt, objective: s.config.objective, state: s.state, kind: s.config.kind, cwd: s.config.cwd, costUsd: 0.5, unpricedCalls: 0, modelCalls: 3, turns: 2, mode: s.config.mode, model: s.config.model, intent: undefined, participant: undefined, shared: false }))
  const applied: VaraConfig[] = []
  let cfg = config()
  const port = makeSystemPort({
    session,
    config: () => cfg,
    apply: async (next) => {
      cfg = next
      applied.push(next)
    },
    hub: new McpHub(),
    version: '0.0.0-test',
    // a vault whose listing, like the real one, also has a "hint" — only names may be taken
    secretNames: async () => namesOnly([{ name: 'OPENAI_API_KEY' }, { name: 'GITHUB_PERSONAL_ACCESS_TOKEN' }]),
    keyState: async () => 'vault',
    listSessions: async () => summaries,
    loadSession: async (id) => (id === other.id ? other : null),
    ...over,
  })
  return { port, applied, session, other }
}

describe('the agent can never read a secret through the system tools', () => {
  it('no topic returns any secret value, only names and presence', async () => {
    registerSecret(SECRETS.registered, 'REGISTERED')
    const { port, other } = setup()
    const outputs: string[] = []
    for (const topic of SYSTEM_TOPICS) {
      const q = { topic, name: 'create-skill', id: other.id, all: true, section: 'transcript' as const }
      outputs.push(await port.inspect(q))
    }
    for (const section of ['summary', 'transcript', 'usage', 'evidence'] as const) outputs.push(await port.inspect({ topic: 'session', id: other.id, section }))
    const all = outputs.join('\n')
    for (const [name, value] of Object.entries(SECRETS)) expect(all, `${name} leaked`).not.toContain(value)
    // …while the useful, non-secret facts are there
    expect(all).toContain('OPENAI_API_KEY')
    expect(all).toContain('DOCS_TOKEN')
    expect(all).toContain('api.openai.com')
    expect(all).toContain('mcp.example.com')
    expect(all).not.toContain('SYSTEM PROMPT SHOULD NOT APPEAR')
  })

  it('shows providers by key state and secret NAME, and connectors by "stored", not by value', async () => {
    const { port } = setup()
    const providers = JSON.parse(await port.inspect({ topic: 'providers' }))
    expect(providers.providers[0].key).toBe('vault')
    expect(providers.providers[0].apiKeySecretName).toBe('OPENAI_API_KEY')
    expect(JSON.stringify(providers)).not.toMatch(/hint|apiKey"/)
    const connectors = JSON.parse(await port.inspect({ topic: 'connectors' }))
    const github = connectors.find((c: { id: string }) => c.id === 'github')
    expect(github.needsSecrets[0]).toMatchObject({ name: 'GITHUB_PERSONAL_ACCESS_TOKEN', stored: true })
  })

  it('MCP servers: environment, headers and secret arguments are listed by name only', async () => {
    const { port } = setup()
    const mcp = JSON.parse(await port.inspect({ topic: 'mcp' }))
    const docs = mcp.find((s: { name: string }) => s.name === 'docs')
    expect(docs.envNames).toEqual(['DOCS_TOKEN'])
    expect(docs.headerNames).toEqual(['Authorization'])
    expect(docs.secretNames).toContain('DOCS_VAULT_TOKEN')
    expect(docs.args).toEqual(['-y', '@scope/docs', '--token', '⟦hidden⟧', '--api-key=⟦hidden⟧'])
    const remote = mcp.find((s: { name: string }) => s.name === 'remote')
    expect(remote.url).toBe('https://mcp.example.com/sse')
    expect(remote.secretNames).toEqual(['REMOTE_TOKEN'])
  })

  it('the vault listing hint (first characters of the value) is dropped', () => {
    expect(namesOnly([{ name: 'A', hint: 'sk…••••' } as never, { name: 'A', hint: 'zz' } as never, { name: 'B' }])).toEqual(['A', 'B'])
  })

  it('urls and arguments are sanitised on their own too', () => {
    expect(safeUrl('https://a:b@h.example.com/p?x=secret#frag')).toBe('https://h.example.com/p')
    expect(safeArgs(['run', '--password', 'x', '--name=ok', '--secret=y'])).toEqual(['run', '--password', '⟦hidden⟧', '--name=ok', '--secret=⟦hidden⟧'])
  })

  it('scrubSystem removes secret assignments, JWTs and VARA-shaped tokens but keeps numbers and prose', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const out = scrubSystem(`password=hunter2hunter2 tokens: 120000 max_tokens=4096 ${jwt} ${SECRETS.owner} plain words`)
    expect(out).not.toContain('hunter2')
    expect(out).not.toContain('eyJhbGci')
    expect(out).not.toContain(SECRETS.owner)
    expect(out).toContain('tokens: 120000')
    expect(out).toContain('max_tokens=4096')
    expect(out).toContain('plain words')
  })

  it('a session is found by id through the store only: a path is not an id', async () => {
    const { port } = setup()
    for (const id of ['../vault', '..\\host\\access.json', '/etc/passwd', 'a/b', '', 'x'.repeat(200)]) {
      await expect(port.inspect({ topic: 'session', id })).rejects.toThrow(/session id|No session/)
    }
    await expect(port.inspect({ topic: 'session', id: 'deadbeef' })).rejects.toThrow(/No session/)
  })

  it('other folders: listed by folder, by "all", and a transcript is wrapped as untrusted data', async () => {
    const { port, other, session } = setup()
    const here = JSON.parse(await port.inspect({ topic: 'sessions' }))
    expect(here.sessions.map((s: { id: string }) => s.id)).toEqual([session.id])
    const there = JSON.parse(await port.inspect({ topic: 'sessions', folder: join(work, 'elsewhere') }))
    expect(there.sessions.map((s: { id: string }) => s.id)).toEqual([other.id])
    const all = JSON.parse(await port.inspect({ topic: 'sessions', all: true }))
    expect(all.sessions).toHaveLength(2)
    const t = JSON.parse(await port.inspect({ topic: 'session', id: other.id, section: 'transcript' }))
    expect(t.note).toMatch(/UNTRUSTED_SESSION_DATA/)
    expect(t.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true)
  })
})

describe('changes beyond selfmanage: only what is allowed, only valid', () => {
  it('refuses settings that grant power or hold secrets, whatever the wording', async () => {
    const { port, applied } = setup()
    for (const key of ['allowPublish', 'agent.browser', 'agent.desktop', 'defaultVerifyCommand', 'providers.openai.apiKeySecret', 'provider.model', 'mcp.servers.docs', 'modes.x', 'nonsense']) {
      await expect(port.setSetting(key, 'true')).rejects.toThrow(/owner|not a setting/)
    }
    expect(applied).toHaveLength(0)
  })

  it('changes an allowed setting after validating it', async () => {
    const { port, applied } = setup()
    await expect(port.setSetting('swarm.maxParallel', '9')).rejects.toThrow(/whole number from 1 to 3/)
    await expect(port.setSetting('agent.defaultMode', 'root')).rejects.toThrow(/plan, build/)
    expect(await port.setSetting('swarm.maxParallel', '2')).toMatch(/2/)
    expect(await port.setSetting('agent.defaultMode', 'plan')).toMatch(/plan/)
    expect(await port.setSetting('swarm.maxCostUsd', 'null')).toMatch(/null/)
    expect(applied.at(-1)?.agent.defaultMode).toBe('plan')
    expect(applied[0]?.swarm.maxParallel).toBe(2)
  })

  it('a connector that needs a token only connects when the token is already stored (and never asks for it)', async () => {
    const missing = setup({ secretNames: async () => [] })
    await expect(missing.port.connector('add', 'github')).rejects.toThrow(/vara connectors add github/)
    expect(missing.applied).toHaveLength(0)
    const stored = setup()
    expect(await stored.port.connector('add', 'github')).toMatch(/Connected/)
    expect(stored.applied.at(-1)?.mcp.servers['github']).toBeTruthy()
    await expect(stored.port.connector('add', 'nope')).rejects.toThrow(/No connector/)
  })

  it('creates, replaces and deletes a custom mode (and rejects reserved names)', async () => {
    const { port, applied } = setup()
    await expect(port.putMode('plan', {})).rejects.toThrow(/Mode name/)
    expect(await port.putMode('reviewer', { base: 'plan', description: 'read only', denyTools: ['shell'] })).toMatch(/Created/)
    expect(applied.at(-1)?.modes['reviewer']?.base).toBe('plan')
    expect(await port.deleteMode('reviewer')).toMatch(/Deleted/)
    await expect(port.deleteMode('reviewer')).rejects.toThrow(/No custom mode/)
  })

  it('deletes a project skill, never a built-in one, and only inside a skills folder', async () => {
    const { port, session } = setup()
    const made = await writeSkill('tmp-skill', 'project', session.config.cwd, 'a throw-away skill', 'step one\nstep two')
    expect(existsSync(made.path)).toBe(true)
    expect(await port.deleteSkill('tmp-skill')).toMatch(/Deleted/)
    expect(existsSync(made.path)).toBe(false)
    await expect(port.deleteSkill('code-review')).rejects.toThrow(/built in/)
    await expect(port.deleteSkill('../../etc')).rejects.toThrow(/Skill name/)
    // a skill whose file sits outside the skills folders is not touched
    await mkdir(join(work, '.vara', 'skills'), { recursive: true })
    await writeFile(join(work, '.vara', 'skills', 'loose.md'), '---\nname: loose\ndescription: loose skill\n---\nbody text here\n')
    expect(await port.deleteSkill('loose')).toMatch(/Deleted/)
    expect(existsSync(join(work, '.vara', 'skills', 'loose.md'))).toBe(false)
  })
})

describe('the tools: owner only, approval for every change', () => {
  const noPort: ToolContext = { cwd: work, mode: 'build', sessionId: 's', scope: 'session:s', env: {}, allowPublish: false }

  function ctxWith(port: SystemPort, answer: boolean | null): { ctx: ToolContext; asked: string[] } {
    const asked: string[] = []
    const ctx: ToolContext = {
      ...noPort,
      admin: { writeSkill: async () => '', setSkillEnabled: async () => '', mcp: async () => '', setMode: async () => '', system: port },
      ...(answer === null ? {} : { approve: async (r) => (asked.push(`${r.action}: ${r.title}`), { approved: answer }) }),
    }
    return { ctx, asked }
  }

  it('without an admin port (guests, headless, sub-agents) nothing is readable or changeable', async () => {
    for (const run of [
      () => varaSystemTool.execute({ topic: 'overview' }, noPort),
      () => skillDeleteTool.execute({ name: 'x' }, noPort),
      () => settingChangeTool.execute({ key: 'agent.defaultMode', value: 'plan' }, noPort),
      () => connectorManageTool.execute({ action: 'add', id: 'github' }, noPort),
      () => modeManageTool.execute({ action: 'delete', name: 'x' }, noPort),
    ]) {
      const r = await run()
      expect(r.ok).toBe(false)
      expect(r.output).toMatch(/not available here/)
    }
  })

  it('the tools are offered only where an owner can be asked, and reading never needs a yes', async () => {
    const names = (canManage: boolean, intent: 'chat' | 'question' | 'task', mode: 'plan' | 'build' = 'build') => toolsFor(intent, mode, { canManage }).map((t) => t.name)
    expect(names(false, 'task')).not.toContain('vara_system')
    expect(names(false, 'task')).not.toContain('setting_change')
    expect(names(true, 'chat')).not.toContain('vara_system')
    expect(names(true, 'question')).toContain('vara_system')
    expect(names(true, 'question')).not.toContain('skill_delete')
    expect(names(true, 'task', 'plan')).toContain('vara_system')
    expect(names(true, 'task', 'plan')).not.toContain('setting_change') // writes are build-only
    expect(names(true, 'task')).toEqual(expect.arrayContaining(['vara_system', 'skill_delete', 'mode_manage', 'setting_change', 'connector_manage']))
    expect(varaSystemTool.readonly).toBe(true)
    for (const t of [skillDeleteTool, modeManageTool, settingChangeTool, connectorManageTool]) expect(t.readonly).toBe(false)
  })

  it('every change asks first, shows what it will do, and does nothing when declined or unanswerable', async () => {
    const { port, applied } = setup()
    const declined = ctxWith(port, false)
    const r1 = await settingChangeTool.execute({ key: 'agent.defaultMode', value: 'plan' }, declined.ctx)
    const r2 = await modeManageTool.execute({ action: 'create', name: 'ro', base: 'plan', denyTools: ['shell'] }, declined.ctx)
    const r3 = await connectorManageTool.execute({ action: 'add', id: 'github' }, declined.ctx)
    for (const r of [r1, r2, r3]) expect(r.output).toMatch(/declined/)
    expect(declined.asked).toHaveLength(3)
    expect(applied).toHaveLength(0)
    const nobody = ctxWith(port, null)
    const r4 = await skillDeleteTool.execute({ name: 'whatever' }, nobody.ctx)
    expect(r4.output).toMatch(/nobody to approve/)
    const yes = ctxWith(port, true)
    const r5 = await settingChangeTool.execute({ key: 'agent.defaultMode', value: 'plan' }, yes.ctx)
    expect(r5.ok).toBe(true)
    expect(applied).toHaveLength(1)
  })

  it('a refused setting is still approved by nobody and reported as refused', async () => {
    const { port, applied } = setup()
    const { ctx } = ctxWith(port, true)
    const r = await settingChangeTool.execute({ key: 'allowPublish', value: 'true' }, ctx)
    expect(r.ok).toBe(false)
    expect(r.output).toMatch(/owner/)
    expect(applied).toHaveLength(0)
  })

  it('vara_system output is plain text the engine will scrub again; errors name no secret', async () => {
    const { port } = setup()
    const { ctx } = ctxWith(port, true)
    const ok = await varaSystemTool.execute({ topic: 'overview' }, ctx)
    expect(ok.ok).toBe(true)
    expect(ok.output).toContain('0.0.0-test')
    const bad = await varaSystemTool.execute({ topic: 'skill', name: 'no-such-skill' }, ctx)
    expect(bad.ok).toBe(false)
  })
})

describe('through the engine: the card shows the exact change, and the agent is told the system block', () => {
  it('reads, asks, and changes only after a yes', async () => {
    const { Engine } = await import('../src/core/engine.js')
    const { makeAdminPort } = await import('../src/core/selfmanage.js')
    const s = mk(work, { objective: 'tune the swarm' })
    let cfg = config()
    const applied: VaraConfig[] = []
    const admin = makeAdminPort({
      session: s,
      config: () => cfg,
      apply: async (n) => ((cfg = n), void applied.push(n)),
      system: { hub: new McpHub(), version: 't', secretNames: async () => ['A_NAME'], keyState: async () => 'vault', listSessions: async () => [], loadSession: async () => null },
    })
    const call = (id: string, name: string, args: unknown) => ({ id, name, arguments: JSON.stringify(args) })
    const script = [
      { content: '', toolCalls: [call('1', 'vara_system', { topic: 'overview' })] },
      { content: '', toolCalls: [call('2', 'setting_change', { key: 'swarm.maxParallel', value: '2' })] },
      { content: 'ok', toolCalls: [call('3', 'ask_user', { question: 'what next, please?' })] },
    ]
    const requests: Array<{ system: string; tools: unknown[] }> = []
    const provider = {
      id: 'openai' as const,
      async *chat(req: { system: string; tools: unknown[] }) {
        requests.push(req)
        const turn = script.shift() ?? { content: 'done', toolCalls: [] }
        if (turn.content) yield { type: 'text' as const, delta: turn.content }
        yield { type: 'done' as const, result: turn }
      },
    }
    const events: Array<{ type: string; request?: { title: string; action: string } }> = []
    const engine: InstanceType<typeof Engine> = new Engine({
      session: s,
      provider: provider as never,
      admin,
      interactive: true,
      onEvent: (e) => {
        events.push(e as never)
        if (e.type === 'approval_request') setImmediate(() => engine.resolveApproval(e.request.id, true))
      },
    })
    await engine.run()
    const card = events.find((e) => e.type === 'approval_request')
    expect(card?.request?.action).toBe('setting_change')
    expect(card?.request?.title).toMatch(/swarm\.maxParallel/)
    expect(applied.at(-1)?.swarm.maxParallel).toBe(2)
    const overview = s.transcript.find((m) => m.toolName === 'vara_system')!
    expect(overview.content).toContain('"vara": "t"')
    const names = (requests[0]!.tools as Array<{ function: { name: string } }>).map((t) => t.function.name)
    expect(names).toEqual(expect.arrayContaining(['vara_system', 'setting_change', 'skill_delete', 'mode_manage', 'connector_manage']))
    expect(requests[0]!.system).toContain('Your own environment')
    expect(requests[0]!.system).toContain('can never read API keys')
  })
})
