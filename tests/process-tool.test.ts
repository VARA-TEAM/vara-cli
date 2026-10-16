import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { shellTool } from '../src/tools/shell-tool.js'
import { processTool } from '../src/tools/process-tool.js'
import { stopAllBackground } from '../src/tools/process-registry.js'
import type { ToolContext } from '../src/tools/types.js'

const ctx = (sessionId: string): ToolContext => ({ cwd: process.cwd(), mode: 'build', sessionId, scope: `session:${sessionId}`, env: { ...(process.env as Record<string, string>), VARA_NO_PACKAGE_CHECK: '1' }, allowPublish: false })
const wait = async (fn: () => Promise<boolean>, ms = 8000) => {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await fn()) return
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('timed out')
}
afterAll(() => stopAllBackground())

describe('background processes', () => {
  it('starts at once, shows its output later, can be stopped, and is private to its session', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vara-bg-'))
    writeFileSync(join(dir, 'server.js'), "console.log('server up'); setInterval(() => {}, 1000);")
    const started = await shellTool.execute({ command: 'node server.js', cwd: dir, background: true }, { ...ctx('s1'), cwd: dir })
    expect(started.ok).toBe(true)
    const id = /Started (bg\d+)/.exec(started.output)![1]!
    await wait(async () => (await processTool.execute({ action: 'log', id }, ctx('s1'))).output.includes('server up'))
    expect((await processTool.execute({ action: 'list' }, ctx('s1'))).output).toContain('running')
    // another session sees nothing
    expect((await processTool.execute({ action: 'list' }, ctx('s2'))).output).toMatch(/No background/)
    expect((await processTool.execute({ action: 'stop', id }, ctx('s2'))).ok).toBe(false)
    expect((await processTool.execute({ action: 'stop', id }, ctx('s1'))).ok).toBe(true)
    await wait(async () => (await processTool.execute({ action: 'list' }, ctx('s1'))).output.includes('exited'))
  })
})
