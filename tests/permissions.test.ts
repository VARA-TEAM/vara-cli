import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { authorize, checkCommandAllowed } from '../src/tools/permissions.js'
import { toolsForMode } from '../src/tools/registry.js'
import type { ToolContext } from '../src/tools/types.js'
import { shellTool, writeFileTool } from '../src/tools/index.js'

const baseCtx = (over: Partial<ToolContext> = {}): ToolContext => ({
  cwd: 'C:\\tmp',
  mode: 'plan',
  sessionId: 's1',
  scope: 'session:s1',
  env: {},
  allowPublish: false,
  ...over,
})

describe('plan mode is enforced at the tool level', () => {
  it('exposes only read-only tools in plan mode', () => {
    const names = toolsForMode('plan').map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).toContain('git_status')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('edit_file')
    expect(names).not.toContain('shell')
    expect(names).not.toContain('git_commit')
    expect(names).not.toContain('gh')
  })

  it('denies a write tool even if the model calls it in plan mode', () => {
    const decision = authorize(writeFileTool as never, { path: 'a.txt', content: 'x' }, baseCtx())
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toMatch(/read-only/i)
  })

  it('denies the shell tool in plan mode (it would bypass the write ban)', () => {
    const decision = authorize(shellTool as never, { command: 'echo hi > a.txt' }, baseCtx())
    expect(decision.allowed).toBe(false)
  })

  it('allows read tools in plan mode', () => {
    const readTool = {
      name: 'read_file',
      description: '',
      schema: z.object({}),
      readonly: true,
      execute: async () => ({ ok: true, output: '' }),
    }
    const decision = authorize(readTool as never, {}, baseCtx())
    expect(decision.allowed).toBe(true)
  })
})

describe('command policy', () => {
  it('blocks publishing unless enabled', () => {
    expect(checkCommandAllowed('git push origin main', baseCtx({ mode: 'build' })).denied).toBe(true)
    expect(checkCommandAllowed('gh repo create x --public', baseCtx({ mode: 'build' })).denied).toBe(true)
    expect(checkCommandAllowed('npm publish', baseCtx({ mode: 'build' })).denied).toBe(true)
    expect(checkCommandAllowed('git push', baseCtx({ mode: 'build', allowPublish: true })).denied).toBe(false)
  })

  it('blocks destructive commands outright', () => {
    expect(checkCommandAllowed('rm -rf /', baseCtx({ mode: 'build' })).denied).toBe(true)
    expect(checkCommandAllowed('rm -rf ~', baseCtx({ mode: 'build' })).denied).toBe(true)
  })

  it('allows ordinary build commands', () => {
    expect(checkCommandAllowed('npm test', baseCtx({ mode: 'build' })).denied).toBe(false)
    expect(checkCommandAllowed('git commit -m "feat: x"', baseCtx({ mode: 'build' })).denied).toBe(false)
  })
})
