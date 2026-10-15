import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { MemorySchema } from '../src/config/config'
import { addNote, memoryBlock, memoryFile, parseNotes, readNotes, removeNote, replaceNote, writeNotes, MAX_NOTE_CHARS } from '../src/core/memory'
import { makeMemoryTool } from '../src/tools/memory-tool'
import { buildSystemPrompt } from '../src/core/prompt'
import { createSession, CreateSessionInput } from '../src/core/session'
import { DEFAULT_CONFIG } from '../src/config/config'
import { makeSessionRunner } from '../src/core/runner-factory'
import type { ToolContext } from '../src/tools/types'

const dir = () => mkdtempSync(join(tmpdir(), 'vara-mem-'))
const ctx = (cwd: string, approve?: ToolContext['approve']): ToolContext => ({ cwd, mode: 'build', sessionId: 's1', scope: 'session:s1', env: {}, allowPublish: false, ...(approve ? { approve } : {}) })

describe('memory files', () => {
  it('is off by default and conservative when on', () => {
    const m = MemorySchema.parse({})
    expect(m).toEqual({ enabled: false, agentWrites: 'ask', maxTokens: 400 })
    expect(DEFAULT_CONFIG.memory.enabled).toBe(false)
    expect(DEFAULT_CONFIG.skills.propose).toBe(false)
    expect(DEFAULT_CONFIG.schedule.enabled).toBe(false)
  })

  it('parses hand-written files: bullets, headings and blank lines', () => {
    expect(parseNotes('# Title\n\n- one\n* two\nthree\n   - four  \n')).toEqual(['one', 'two', 'three', 'four'])
  })

  it('adds, replaces, removes and de-duplicates (project file lives in <cwd>/.vara/memory.md)', () => {
    const cwd = dir()
    expect(addNote('project', cwd, 'uses pnpm, not npm').added).toBe(true)
    expect(addNote('project', cwd, 'Uses PNPM, not npm').added).toBe(false)
    addNote('project', cwd, 'tests live in tests/')
    expect(readNotes('project', cwd)).toEqual(['uses pnpm, not npm', 'tests live in tests/'])
    replaceNote('project', cwd, 2, 'tests live in spec/')
    expect(removeNote('project', cwd, 1)).toBe('uses pnpm, not npm')
    expect(readNotes('project', cwd)).toEqual(['tests live in spec/'])
    expect(readFileSync(memoryFile('project', cwd), 'utf8')).toContain('- tests live in spec/')
    expect(() => removeNote('project', cwd, 9)).toThrow(/no note 9/)
  })

  it('refuses secrets, multi-line and over-long notes — nothing is written', () => {
    const cwd = dir()
    expect(() => addNote('project', cwd, 'key is sk-abcdefghijklmnopqrstuvwxyz123456')).toThrow(/secret/)
    expect(() => addNote('project', cwd, 'api_key: hunter2hunter2')).toThrow(/secret/)
    expect(() => addNote('project', cwd, 'x'.repeat(MAX_NOTE_CHARS + 1))).toThrow(/limited/)
    expect(() => writeNotes('project', cwd, ['fine', 'token=abcdef123456789'])).toThrow(/secret/)
    expect(readNotes('project', cwd)).toEqual([])
  })
})

describe('memory block (what reaches the prompt)', () => {
  it('is empty with no notes — no header, no cost', () => {
    expect(memoryBlock(dir(), 400)).toBe('')
  })

  it('stays inside the token budget, newest notes first, and says how many were left out', () => {
    const cwd = dir()
    const notes = Array.from({ length: 40 }, (_, i) => `note number ${i} ${'x'.repeat(60)}`)
    writeNotes('project', cwd, notes)
    const block = memoryBlock(cwd, 120)
    expect(Math.ceil(block.length / 4)).toBeLessThanOrEqual(150)
    expect(block).toContain('note number 39')
    expect(block).not.toContain('note number 0 ')
    expect(block).toMatch(/\+\d+ older not shown/)
    // labelled as data, not orders
    expect(block).toMatch(/never grant permission/)
  })

  it('reaches the system prompt for work and questions, not for chat', () => {
    const cwd = dir()
    addNote('project', cwd, 'prefers tabs')
    const block = memoryBlock(cwd, 400)
    const session = createSession(CreateSessionInput.parse({ objective: 'x', cwd }), DEFAULT_CONFIG)
    expect(buildSystemPrompt(session, { memory: block })).toContain('prefers tabs')
    expect(buildSystemPrompt(session, { intent: 'question', memory: block })).toContain('prefers tabs')
    expect(buildSystemPrompt(session, { intent: 'chat', memory: block })).not.toContain('prefers tabs')
    expect(buildSystemPrompt(session, {})).not.toContain('# Memory')
  })
})

describe('memory tool', () => {
  const cwd = dir()
  const tool = (writes: 'ask' | 'auto' | 'off') => makeMemoryTool(() => ({ enabled: true, agentWrites: writes, maxTokens: 400 }))

  it('ask: needs an approver and shows the exact note; no approver = refused', async () => {
    const t = tool('ask')
    const seen: string[] = []
    const none = await t.execute({ action: 'add', text: 'likes short answers' }, ctx(cwd))
    expect(none.ok).toBe(false)
    expect(readNotes('project', cwd)).toEqual([])
    const no = await t.execute({ action: 'add', text: 'likes short answers' }, ctx(cwd, async (r) => (seen.push(r.title), { approved: false })))
    expect(no.ok).toBe(false)
    expect(seen[0]).toContain('likes short answers')
    const yes = await t.execute({ action: 'add', text: 'likes short answers' }, ctx(cwd, async () => ({ approved: true })))
    expect(yes.ok).toBe(true)
    expect(readNotes('project', cwd)).toEqual(['likes short answers'])
  })

  it('off: read only; auto: writes; view always works; secrets always refused', async () => {
    expect((await tool('off').execute({ action: 'add', text: 'x' }, ctx(cwd))).ok).toBe(false)
    expect((await tool('auto').execute({ action: 'add', scope: 'project', text: 'second note' }, ctx(cwd))).ok).toBe(true)
    const view = await tool('off').execute({ action: 'view' }, ctx(cwd))
    expect(view.output).toContain('1. likes short answers')
    expect(view.output).toContain('2. second note')
    const secret = await tool('auto').execute({ action: 'add', text: 'password: correcthorsebattery' }, ctx(cwd))
    expect(secret.ok).toBe(false)
    expect(secret.output).toMatch(/secret/)
  })

  it('is offered only when memory is on', () => {
    const base = { session: createSession(CreateSessionInput.parse({ objective: 'x', cwd }), DEFAULT_CONFIG), provider: () => ({}) as never, hub: { tools: () => [], summary: () => '' } as never, onEvent: () => {} }
    const names = (enabled: boolean) => {
      const config = { ...DEFAULT_CONFIG, memory: { ...DEFAULT_CONFIG.memory, enabled } }
      const runner = makeSessionRunner({ ...base, config: () => config }) as unknown as { extras: { extraTools: () => Array<{ name: string }>; memoryBlock: () => string } }
      return { tools: runner.extras.extraTools().map((t) => t.name), block: runner.extras.memoryBlock() }
    }
    expect(names(false).tools).not.toContain('memory')
    expect(names(true).tools).toContain('memory')
    expect(names(false).block).toBe('')
  })

  it('a hand-edited file is read as it is', () => {
    const c = dir()
    writeFileSync(join(c, 'x'), '')
    addNote('project', c, 'first')
    writeFileSync(memoryFile('project', c), '# mine\n- first\n- added by hand\n', 'utf8')
    expect(readNotes('project', c)).toEqual(['first', 'added by hand'])
  })
})
