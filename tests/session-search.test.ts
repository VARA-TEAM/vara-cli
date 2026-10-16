import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'
import { ensureStore, saveSession } from '../src/core/store.js'
import { sessionSearchTool } from '../src/tools/session-search.js'

let work: string
let other: string
beforeAll(async () => {
  await ensureStore()
  work = await mkdtemp(join(tmpdir(), 'vara-ss-'))
  other = await mkdtemp(join(tmpdir(), 'vara-ss2-'))
})
afterAll(async () => {
  await rm(work, { recursive: true, force: true })
  await rm(other, { recursive: true, force: true })
})

const make = async (cwd: string, objective: string, said: string) => {
  const s = createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective, acceptance: ['x'], cwd, auto: false }), DEFAULT_CONFIG)
  s.transcript.push({ role: 'user', content: said, at: new Date().toISOString() })
  await saveSession(s)
  return s
}

describe('session_search', () => {
  it('finds what was said in an earlier session of this folder, with its id, and not in other folders unless asked', async () => {
    const a = await make(work, 'tune the retry logic', 'We decided the retry logic uses exponential backoff with jitter, max 5 tries.')
    await make(other, 'something else', 'The retry logic in the other project is linear.')
    const ctx = { cwd: work, mode: 'build' as const, sessionId: 'current', scope: 's', env: {}, allowPublish: false }
    const here = await sessionSearchTool.execute({ query: 'retry logic' }, ctx)
    expect(here.ok).toBe(true)
    expect(here.output).toContain(a.id)
    expect(here.output).toContain('exponential backoff')
    expect(here.output).not.toContain('linear')
    const all = await sessionSearchTool.execute({ query: 'retry logic', allFolders: true }, ctx)
    expect(all.output).toContain('linear')
    expect((await sessionSearchTool.execute({ query: 'zebra unicorn' }, ctx)).output).toMatch(/No earlier session/)
  })
})
