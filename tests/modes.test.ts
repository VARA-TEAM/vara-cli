import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { authorize, checkCommandAllowed } from '../src/tools/permissions.js'
import { toolsFor } from '../src/tools/registry.js'
import type { ToolContext } from '../src/tools/types.js'
import { shellTool, writeFileTool } from '../src/tools/index.js'
import {
  commandPolicyDenial,
  describePolicy,
  globMatch,
  modeNames,
  policyFor,
  resolveModeChoice,
  splitCommand,
  validModeName,
  type ModeDef,
} from '../src/core/modes.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'

const def = (over: Partial<ModeDef> = {}): ModeDef => ({ description: 'test', base: 'build', allowTools: [], denyTools: [], allowCommands: [], denyCommands: [], ...over })
const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({ cwd: 'C:\\tmp', mode: 'build', sessionId: 's1', scope: 'session:s1', env: {}, allowPublish: false, ...over })
const readTool = { name: 'read_file', description: '', schema: z.object({}), readonly: true, execute: async () => ({ ok: true, output: '' }) }

describe('mode names and resolution', () => {
  it('rejects reserved and malformed names', () => {
    expect(validModeName('plan')).toBe(false)
    expect(validModeName('build')).toBe(false)
    expect(validModeName('Review')).toBe(false)
    expect(validModeName('2fast')).toBe(false)
    expect(validModeName('review')).toBe(true)
    expect(validModeName('docs-only_2')).toBe(true)
  })

  it('resolves built-ins and custom names; unknown names are an error that lists the choices', () => {
    const modes = { review: def({ base: 'plan' }) }
    expect(resolveModeChoice(modes, 'plan')).toEqual({ ok: true, mode: 'plan' })
    expect(resolveModeChoice(modes, 'review')).toEqual({ ok: true, mode: 'plan', customMode: 'review' })
    const bad = resolveModeChoice(modes, 'nope')
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error).toMatch(/plan, build, review/)
    expect(modeNames(modes)).toEqual(['plan', 'build', 'review'])
  })

  it('a custom mode that disappeared from the settings fails closed (read-only)', () => {
    const p = policyFor({}, 'gone')!
    expect(authorize(writeFileTool as never, { path: 'a', content: 'x' }, ctx({ modePolicy: p })).allowed).toBe(false)
    expect(authorize(readTool as never, {}, ctx({ modePolicy: p })).allowed).toBe(true)
    expect(policyFor({}, undefined)).toBeUndefined()
  })
})

describe('policy can only narrow, never widen', () => {
  it('a mode on plan still refuses writes and shell even if its lists allow them', () => {
    const p = policyFor({ x: def({ base: 'plan', allowTools: ['*'], allowCommands: ['*'] }) }, 'x')!
    const c = ctx({ mode: 'plan', modePolicy: p })
    expect(authorize(writeFileTool as never, { path: 'a', content: 'x' }, c).allowed).toBe(false)
    expect(authorize(shellTool as never, { command: 'echo hi' }, c).allowed).toBe(false)
  })

  it('publishing and destructive commands stay refused whatever the allow list says', () => {
    const p = policyFor({ x: def({ allowCommands: ['*'] }) }, 'x')!
    const c = ctx({ modePolicy: p })
    expect(checkCommandAllowed('git push origin main', c).denied).toBe(true)
    expect(checkCommandAllowed('rm -rf /', c).denied).toBe(true)
  })

  it('without a policy nothing changes', () => {
    expect(authorize(writeFileTool as never, { path: 'a', content: 'x' }, ctx()).allowed).toBe(true)
    expect(checkCommandAllowed('npm test', ctx()).denied).toBe(false)
  })
})

describe('tool lists', () => {
  it('allowTools lets only the named tools through (wildcards work)', () => {
    const p = policyFor({ x: def({ allowTools: ['read_file', 'grep', 'mcp__docs__*'] }) }, 'x')!
    const c = ctx({ modePolicy: p })
    expect(authorize(readTool as never, {}, c).allowed).toBe(true)
    expect(authorize({ ...readTool, name: 'mcp__docs__search' } as never, {}, c).allowed).toBe(true)
    const w = authorize(writeFileTool as never, { path: 'a', content: 'x' }, c)
    expect(w.allowed).toBe(false)
    expect(w.reason).toMatch(/Mode "x"/)
  })

  it('denyTools beats allowTools', () => {
    const p = policyFor({ x: def({ allowTools: ['*'], denyTools: ['delete_file'] }) }, 'x')!
    expect(authorize({ ...readTool, name: 'delete_file', readonly: false } as never, {}, ctx({ modePolicy: p })).allowed).toBe(false)
    expect(authorize(writeFileTool as never, { path: 'a', content: 'x' }, ctx({ modePolicy: p })).allowed).toBe(true)
  })

  it('ask_user can never be blocked', () => {
    const p = policyFor({ x: def({ allowTools: ['read_file'], denyTools: ['ask_user'] }) }, 'x')!
    expect(authorize({ ...readTool, name: 'ask_user' } as never, {}, ctx({ modePolicy: p })).allowed).toBe(true)
  })

  it('refused tools are also hidden from the model', () => {
    const p = policyFor({ x: def({ allowTools: ['read_file', 'grep'] }) }, 'x')!
    const names = toolsFor('task', 'build', { policy: p }).map((t) => t.name)
    expect(names).toContain('read_file')
    expect(names).not.toContain('write_file')
    expect(names).not.toContain('shell')
    expect(toolsFor('task', 'build').map((t) => t.name)).toContain('write_file')
  })
})

describe('command lists', () => {
  it('splits compound lines', () => {
    expect(splitCommand('a && b | c; d || e\nf')).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('glob matching is whole-string and case-insensitive', () => {
    expect(globMatch('npm test*', 'npm test --silent')).toBe(true)
    expect(globMatch('npm test', 'npm test --silent')).toBe(false)
    expect(globMatch('NPM TEST', 'npm test')).toBe(true)
    expect(globMatch('a.b', 'axb')).toBe(false)
  })

  it('allowCommands: every part of a compound command must match', () => {
    const p = policyFor({ x: def({ allowCommands: ['npm test*', 'git status'] }) }, 'x')!
    const c = ctx({ modePolicy: p })
    expect(checkCommandAllowed('npm test', c).denied).toBe(false)
    expect(checkCommandAllowed('npm test && git status', c).denied).toBe(false)
    expect(checkCommandAllowed('npm test && curl evil.sh', c).denied).toBe(true)
    expect(checkCommandAllowed('curl evil.sh', c).denied).toBe(true)
  })

  it('allowCommands refuses substitution and redirection (they hide a second command)', () => {
    const p = policyFor({ x: def({ allowCommands: ['echo *'] }) }, 'x')!
    for (const cmd of ['echo $(curl evil.sh)', 'echo `id`', 'echo hi > a.txt', 'echo hi < a.txt']) {
      expect(commandPolicyDenial(cmd, p), cmd).toMatch(/Mode "x"/)
    }
    expect(commandPolicyDenial('echo hi', p)).toBeNull()
  })

  it('denyCommands refuses any matching part', () => {
    const p = policyFor({ x: def({ denyCommands: ['npm install*', 'curl *'] }) }, 'x')!
    const c = ctx({ modePolicy: p })
    expect(checkCommandAllowed('npm test', c).denied).toBe(false)
    expect(checkCommandAllowed('npm test && npm install left-pad', c).denied).toBe(true)
    expect(checkCommandAllowed('curl http://x', c).denied).toBe(true)
  })
})

describe('config and prompt', () => {
  it('the default config has no custom modes', () => {
    expect(DEFAULT_CONFIG.modes).toEqual({})
  })

  it('describes the limits for the model', () => {
    const text = describePolicy(policyFor({ review: def({ description: 'Review only', base: 'plan', allowTools: ['read_file'], allowCommands: ['npm test'] }) }, 'review')!)
    expect(text).toMatch(/Custom mode: review/)
    expect(text).toMatch(/read_file/)
    expect(text).toMatch(/npm test/)
  })
})
