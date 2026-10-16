import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Provider, ProviderEvent, ProviderRequest } from '../src/llm/provider.js'
import { DEFAULT_CONFIG } from '../src/config/config.js'
import { SessionRunner } from '../src/core/runner.js'
import { createSession, CreateSessionInput } from '../src/core/session.js'

/** The first request hangs until it is aborted (the user pressed stop); later ones answer. */
class Hanging implements Provider {
  id = 'openai' as const
  calls = 0
  seen: string[] = []
  async *chat(req: ProviderRequest): AsyncIterable<ProviderEvent> {
    this.calls++
    this.seen.push(JSON.stringify(req.messages))
    if (this.calls === 1) {
      await new Promise<void>((resolve) => req.signal?.addEventListener('abort', () => resolve(), { once: true }))
      yield { type: 'error', message: 'aborted' }
      return
    }
    yield { type: 'done', result: { content: 'hello again', toolCalls: [{ id: 'q', name: 'ask_user', arguments: JSON.stringify({ question: 'anything else?' }) }] } }
  }
}

let work: string
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), 'vara-pr-'))
})
afterAll(() => rm(work, { recursive: true, force: true }))

describe('stopping a run does not strand the session', () => {
  it('a message sent while the run is stopping starts it again, and a later message still works', async () => {
    const session = createSession(CreateSessionInput.parse({ kind: 'task', mode: 'build', objective: 'do a thing', acceptance: ['x'], cwd: work, auto: false }), DEFAULT_CONFIG)
    const provider = new Hanging()
    const runner = new SessionRunner(session, provider, undefined, () => {})
    const first = runner.start()
    await new Promise((r) => setTimeout(r, 100))
    runner.pause()
    runner.send('please continue with plan B') // arrives while the stopped run is still unwinding
    await first
    expect(runner.isRunning).toBe(false)
    expect(provider.calls).toBeGreaterThanOrEqual(2)
    expect(provider.seen.join('')).toContain('plan B')
    // and the session accepts the next message normally
    runner.send('and one more thing')
    await runner.start()
    expect(provider.seen.join('')).toContain('one more thing')
  }, 20_000)
})
