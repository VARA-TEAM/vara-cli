import { existsSync, readFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config'
import { approveProposal, createProposal, getProposal, listProposals, rejectProposal, MAX_PER_SESSION } from '../src/core/proposals'
import { discoverSkills } from '../src/core/skills'
import { skillProposeTool } from '../src/tools/proposal-tool'
import { proposalReply } from '../src/tui/memory-commands'
import { makeSessionRunner } from '../src/core/runner-factory'
import { createSession, CreateSessionInput } from '../src/core/session'
import type { ToolContext } from '../src/tools/types'

const dir = () => mkdtempSync(join(tmpdir(), 'vara-prop-'))
const input = (cwd: string, over: Record<string, unknown> = {}) => ({ name: 'release-notes', scope: 'project' as const, description: 'Use when asked for release notes', body: '1. read git log\n2. group by type', reason: 'did it by hand twice', cwd, sessionId: 's1', ...over })

describe('skill proposals', () => {
  it('a proposal is only a file: nothing is installed, the agent cannot see it as a skill', async () => {
    const cwd = dir()
    const p = await createProposal(input(cwd))
    expect(await listProposals()).toHaveLength(1)
    expect((await discoverSkills(cwd)).some((s) => s.name === 'release-notes')).toBe(false)
    expect(existsSync(join(cwd, '.vara', 'skills', 'release-notes', 'SKILL.md'))).toBe(false)
    await rejectProposal(p.id)
  })

  it('approving installs it (and removes the proposal); rejecting installs nothing', async () => {
    const cwd = dir()
    const a = await createProposal(input(cwd, { name: 'alpha', sessionId: 'a' }))
    const b = await createProposal(input(cwd, { name: 'beta', sessionId: 'b' }))
    const r = await approveProposal(a.id)
    expect(r.created).toBe(true)
    expect(readFileSync(r.path, 'utf8')).toContain('name: alpha')
    expect((await discoverSkills(cwd)).some((s) => s.name === 'alpha')).toBe(true)
    expect(await getProposal(a.id)).toBeNull()
    expect(await rejectProposal(b.id)).toBe(true)
    expect((await discoverSkills(cwd)).some((s) => s.name === 'beta')).toBe(false)
    expect(await rejectProposal(b.id)).toBe(false)
  })

  it('an improvement to an existing skill is flagged as replacing it', async () => {
    const cwd = dir()
    const p = await createProposal(input(cwd, { name: 'create-skill', scope: 'user' }))
    expect(p.replaces).toBe('builtin')
    await rejectProposal(p.id)
  })

  it('refuses secrets, bad names, empty or oversized bodies, duplicates and floods', async () => {
    const cwd = dir()
    await expect(createProposal(input(cwd, { body: 'use key sk-abcdefghijklmnopqrstuvwxyz123456' }))).rejects.toThrow(/secret/)
    await expect(createProposal(input(cwd, { name: '../evil' }))).rejects.toThrow(/Skill name/)
    await expect(createProposal(input(cwd, { body: '  ' }))).rejects.toThrow(/empty/)
    await expect(createProposal(input(cwd, { body: 'x'.repeat(9000) }))).rejects.toThrow(/limited/)
    const made: string[] = []
    for (let i = 0; i < MAX_PER_SESSION; i++) made.push((await createProposal(input(cwd, { name: `flood-${i}`, sessionId: 'flooder' }))).id)
    await expect(createProposal(input(cwd, { name: 'flood-x', sessionId: 'flooder' }))).rejects.toThrow(/per session/)
    await expect(createProposal(input(cwd, { name: 'flood-0', sessionId: 'other' }))).rejects.toThrow(/already waiting/)
    for (const id of made) await rejectProposal(id)
  })

  it('a path-like id can never reach outside the proposals folder', async () => {
    expect(await getProposal('../../config')).toBeNull()
    expect(await rejectProposal('../../config')).toBe(false)
    await expect(approveProposal('../x')).rejects.toThrow(/No proposal/)
  })

  it('the tool works only in the owner\'s own session (an admin port), and says it installed nothing', async () => {
    const cwd = dir()
    const ctx = { cwd, mode: 'build', sessionId: 'tool1', scope: 's', env: {}, allowPublish: false } as ToolContext
    const args = { name: 'tool-made', description: 'when X', body: 'steps', reason: 'why' }
    expect((await skillProposeTool.execute(args, ctx)).ok).toBe(false)
    const ok = await skillProposeTool.execute(args, { ...ctx, admin: {} as never })
    expect(ok.ok).toBe(true)
    expect(ok.output).toMatch(/not installed/)
    const [p] = await listProposals().then((l) => l.filter((x) => x.name === 'tool-made'))
    expect(p?.cwd).toBe(cwd)
    await rejectProposal(p!.id)
  })

  it('the TUI replies list, show, approve and reject', async () => {
    const cwd = dir()
    const p = await createProposal(input(cwd, { name: 'tui-skill', sessionId: 'tui' }))
    expect((await proposalReply(['proposals'])).text).toContain('tui-skill')
    expect((await proposalReply(['show', p.id])).text).toContain('read git log')
    expect((await proposalReply(['approve', p.id])).skillsChanged).toBe(true)
    expect((await proposalReply(['reject', p.id])).error).toBe(true)
  })

  it('is offered only with skills.propose on, and only in sessions that have an admin port (applyConfig)', () => {
    const cwd = dir()
    const base = { session: createSession(CreateSessionInput.parse({ objective: 'x', cwd }), DEFAULT_CONFIG), provider: () => ({}) as never, hub: { tools: () => [], summary: () => '' } as never, onEvent: () => {} }
    const names = (propose: boolean, withApply: boolean) => {
      const config = { ...DEFAULT_CONFIG, skills: { ...DEFAULT_CONFIG.skills, propose } }
      const runner = makeSessionRunner({ ...base, config: () => config, ...(withApply ? { applyConfig: async () => {} } : {}) }) as unknown as { extras: { extraTools: () => Array<{ name: string }> } }
      return runner.extras.extraTools().map((t) => t.name)
    }
    expect(names(false, true)).not.toContain('skill_propose')
    expect(names(true, false)).not.toContain('skill_propose')
    expect(names(true, true)).toContain('skill_propose')
  })
})
