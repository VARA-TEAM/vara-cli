import React from 'react'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { render, cleanup } from 'ink-testing-library'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Provider, ProviderRequest, ProviderEvent, AssistantTurn } from '../src/llm/provider.js'
import { DEFAULT_CONFIG, type VaraConfig } from '../src/config/config.js'
import { App } from '../src/tui/App.js'
import { applyTheme } from '../src/tui/theme.js'
import { expandMentions, findMentions, cleanTitle, ATTACH_MARK } from '../src/tui/mentions.js'
import { serverFromInput, splitCommand } from '../src/tui/mcp.js'
import { McpHub } from '../src/mcp/hub.js'
import { Engine } from '../src/core/engine.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'

const ENTER = '\r'
const ESC = '\x1b'
const settle = () => new Promise((r) => setTimeout(r, 70))

afterEach(() => {
  cleanup()
  applyTheme('vara')
})

class FakeProvider implements Provider {
  id = 'openai' as const
  requests: ProviderRequest[] = []
  constructor(private readonly script: AssistantTurn[]) {}
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.requests.push(JSON.parse(JSON.stringify({ ...req, signal: undefined })) as ProviderRequest)
    const turn = this.script.shift() ?? { content: 'ok', toolCalls: [] }
    if (turn.content) yield { type: 'text', delta: turn.content }
    yield { type: 'done', result: turn }
  }
}

const cfg: VaraConfig = { ...DEFAULT_CONFIG, provider: { ...DEFAULT_CONFIG.provider, model: 'gpt-4o' } }

async function renderHome(config: VaraConfig = cfg, provider: Provider = new FakeProvider([])) {
  const inst = render(<App session={null} provider={provider} config={config} autoStart={false} />)
  await vi.waitFor(() => expect(inst.lastFrame()).toContain('Enter send'))
  await settle()
  return inst
}

describe('@file mentions', () => {
  it('finds mentions and attaches only real files inside the folder', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-ment-'))
    await mkdir(join(dir, 'src'))
    await writeFile(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(dir, 'bin.dat'), Buffer.from([1, 2, 0, 3]))
    expect(findMentions('fix @src/a.ts and @nope.ts, see @bin.dat. Email me@x.com')).toEqual(['src/a.ts', 'nope.ts', 'bin.dat'])
    const { text, files } = await expandMentions('fix @src/a.ts and @nope.ts and @bin.dat and @../outside.txt', dir)
    expect(files).toEqual(['src/a.ts'])
    expect(text).toContain('<file path="src/a.ts">')
    expect(text).toContain('export const a = 1')
    expect(text).not.toContain('bin.dat">')
    expect(cleanTitle(text)).toBe('fix @src/a.ts and @nope.ts and @bin.dat and @../outside.txt')
    expect(text.includes(ATTACH_MARK)).toBe(true)
    // Nothing to attach → the text is untouched.
    expect((await expandMentions('just words', dir)).text).toBe('just words')
    await rm(dir, { recursive: true, force: true })
  })
})

describe('MCP input parsing', () => {
  it('splits command lines with quotes and recognises URLs', () => {
    expect(splitCommand('npx -y "@scope/pkg name" --flag')).toEqual(['npx', '-y', '@scope/pkg name', '--flag'])
    expect(serverFromInput('npx -y @modelcontextprotocol/server-memory')).toMatchObject({ command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] })
    expect(serverFromInput('https://mcp.example.com/mcp')).toMatchObject({ url: 'https://mcp.example.com/mcp' })
    expect(typeof serverFromInput('   ')).toBe('string')
  })
})

describe('agent awareness: MCP + skills + sub-agents', () => {
  it('lists MCP servers and skills in the prompt and runs an MCP tool through the engine', async () => {
    const hub = new McpHub()
    await hub.sync({ fixture: { command: process.execPath, args: [join(process.cwd(), 'tests', 'fixtures', 'mcp-server.mjs')] } })
    const { BUILTIN_SKILLS } = await import('../src/core/builtin-skills.js')
    const session = createSession(CreateSessionInput.parse({ objective: 'add two numbers with the tool', cwd: process.cwd(), kind: 'task' }), DEFAULT_CONFIG)
    const provider = new FakeProvider([
      { content: '', toolCalls: [{ id: 'm1', name: 'mcp__fixture__add', arguments: JSON.stringify({ a: 20, b: 22 }) }] },
      { content: '', toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify({ question: 'The answer is 42. Anything else?' }) }] },
    ])
    await new Engine({
      session,
      provider,
      extraTools: () => hub.tools(),
      mcpSummary: () => hub.summary(),
      loadSkills: async () => BUILTIN_SKILLS,
    }).run()
    const req = provider.requests[0]!
    expect(req.system).toContain('mcp__fixture__<tool>')
    expect(req.system).toContain('code-review:')
    expect(req.system).toContain('delegate')
    const names = req.tools.map((t) => (t as { function: { name: string } }).function.name)
    expect(names).toContain('mcp__fixture__add')
    expect(names).toContain('skill')
    expect(names).toContain('delegate')
    expect(session.transcript.find((m) => m.toolName === 'mcp__fixture__add')!.content).toContain('42')
    hub.closeAll()
  })

  it('a question may use read-only MCP tools but not the others', async () => {
    const hub = new McpHub()
    await hub.sync({ fixture: { command: process.execPath, args: [join(process.cwd(), 'tests', 'fixtures', 'mcp-server.mjs')] } })
    const session = createSession(CreateSessionInput.parse({ objective: 'what does the echo tool say?', cwd: process.cwd(), auto: true }), DEFAULT_CONFIG)
    const provider = new FakeProvider([{ content: 'It echoes.', toolCalls: [] }])
    await new Engine({ session, provider, extraTools: () => hub.tools() }).run()
    const names = provider.requests[0]!.tools.map((t) => (t as { function: { name: string } }).function.name)
    expect(names).toContain('mcp__fixture__echo')
    expect(names).not.toContain('mcp__fixture__add')
    hub.closeAll()
  })
})

describe('TUI — new commands', () => {
  it('/mcp opens the MCP screen with presets; Esc closes it', async () => {
    const { lastFrame, stdin, unmount } = await renderHome()
    stdin.write('/mcp')
    await settle()
    stdin.write(ENTER)
    await vi.waitFor(() => expect(lastFrame()).toContain('MCP servers'))
    expect(lastFrame()).toContain('+ Custom server')
    expect(lastFrame()).toContain('Filesystem')
    await settle()
    stdin.write(ESC)
    await vi.waitFor(() => expect(lastFrame()).not.toContain('MCP servers'))
    unmount()
  })

  it('/think explains when the model has no thinking control, and sets a level when it has one', async () => {
    const a = await renderHome()
    a.stdin.write('/think')
    await settle()
    a.stdin.write(ENTER)
    await vi.waitFor(() => expect(a.lastFrame()).toContain('no thinking control'))
    a.unmount()

    const o3: VaraConfig = { ...cfg, provider: { ...cfg.provider, model: 'o3' } }
    const b = await renderHome(o3)
    b.stdin.write('/think')
    await settle()
    b.stdin.write(ENTER)
    await vi.waitFor(() => expect(b.lastFrame()).toContain('thinking: medium'))
    b.stdin.write('/think high')
    await settle()
    b.stdin.write(ENTER)
    await vi.waitFor(() => expect(b.lastFrame()).toContain('thinking → high'))
    b.stdin.write('/think off')
    await settle()
    b.stdin.write(ENTER)
    await vi.waitFor(() => expect(b.lastFrame()).toContain('supports: low | medium | high'))
    b.unmount()
  })

  it('/cost and /export work in a session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'vara-exp-'))
    const prev = process.cwd()
    process.chdir(dir)
    try {
      const provider = new FakeProvider([{ content: 'Hello there!', toolCalls: [] }])
      const { lastFrame, stdin, unmount } = await renderHome(cfg, provider)
      stdin.write('hello')
      await settle()
      stdin.write(ENTER)
      await vi.waitFor(() => expect(lastFrame()).toContain('Hello there!'), { timeout: 5_000 })
      await vi.waitFor(() => expect(lastFrame()).toContain('READY'))
      await settle()
      stdin.write('/cost')
      await settle()
      stdin.write(ENTER)
      await vi.waitFor(() => expect(lastFrame()).toContain('saved by VARA'))
      stdin.write('/export notes.md')
      await settle()
      stdin.write(ENTER)
      await vi.waitFor(() => expect(lastFrame()).toContain('exported'))
      const md = await readFile(join(dir, 'notes.md'), 'utf8')
      expect(md).toContain('## You')
      expect(md).toContain('hello')
      expect(md).toContain('## VARA')
      expect(md).toContain('Hello there!')
      unmount()
    } finally {
      process.chdir(prev)
      await rm(dir, { recursive: true, force: true })
    }
  })
})
