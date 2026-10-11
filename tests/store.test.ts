import { beforeAll, describe, expect, it } from 'vitest'
import { DEFAULT_CONFIG } from '../src/config/config.js'

let store: typeof import('../src/core/store.js')
let createSession: typeof import('../src/core/session.js').createSession
let CreateSessionInput: typeof import('../src/core/session.js').CreateSessionInput

beforeAll(async () => {
  store = await import('../src/core/store.js')
  const s = await import('../src/core/session.js')
  createSession = s.createSession
  CreateSessionInput = s.CreateSessionInput
})

function makeSession() {
  return createSession(
    CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'Persist me', cwd: process.cwd() }),
    DEFAULT_CONFIG,
  )
}

describe('session persistence', () => {
  it('round-trips a session through disk', async () => {
    const session = makeSession()
    session.transcript.push({ role: 'user', content: 'hello', at: new Date().toISOString() })
    await store.saveSession(session)

    const loaded = await store.loadSession(session.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.config.objective).toBe('Persist me')
    expect(loaded?.transcript[0]?.content).toBe('hello')
  })

  it('recovers a session that was running when the process died as interrupted, not successful', async () => {
    const session = makeSession()
    session.state = 'running'
    await store.saveSession(session)

    const loaded = await store.loadSession(session.id)
    expect(loaded?.state).toBe('interrupted')
    expect(loaded?.stateReason).toMatch(/did NOT complete/i)
  })

  it('appends an auditable event log', async () => {
    const session = makeSession()
    await store.appendEvent(session.id, { type: 'state', state: 'running' })
    await store.appendEvent(session.id, { type: 'turn', turn: 1 })
    const events = await store.readEventLog(session.id)
    expect(events.length).toBeGreaterThanOrEqual(2)
    expect(events.some((e) => e['type'] === 'turn')).toBe(true)
  })

  it('lists persisted sessions', async () => {
    const list = await store.listSessions()
    expect(list.length).toBeGreaterThanOrEqual(2)
  })

  it('never creates a session with an empty requirement list (0/0 would fake success)', () => {
    const session = makeSession()
    expect(session.activeRequirements?.length).toBeGreaterThan(0)
    // The objective itself becomes requirement #1 when no acceptance was given.
    expect(session.activeRequirements?.[0]).toContain('Persist me')
  })

  it('migrates a legacy session that has no activeRequirements on load', async () => {
    const session = makeSession()
    await store.saveSession(session)
    // Simulate a session written before requirement tracking existed.
    const { readFile, writeFile } = await import('node:fs/promises')
    const { sessionStateFile } = await import('../src/config/paths.js')
    const file = sessionStateFile(session.id)
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>
    delete raw['activeRequirements']
    await writeFile(file, JSON.stringify(raw), 'utf8')

    const loaded = await store.loadSession(session.id)
    expect(loaded?.activeRequirements?.length).toBeGreaterThan(0)
  })
})
