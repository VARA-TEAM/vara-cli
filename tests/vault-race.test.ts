import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const run = promisify(execFile)

/**
 * Regression (found by CI): several VARA processes starting at once on a fresh
 * machine each created their own master key, so the last writer made everyone
 * else's secrets unreadable. Every process must end up with the SAME key.
 */
describe('vault master key creation is race-safe', () => {
  it('four processes starting together agree on one key', async () => {
    const home = await mkdtemp(join(tmpdir(), 'vara-race-'))
    try {
      const script = join(process.cwd(), 'tests', 'fixtures', 'master-key.ts')
      const results = await Promise.all(
        Array.from({ length: 4 }, () => run(process.execPath, ['--import', 'tsx', script], { env: { ...process.env, VARA_HOME: home }, timeout: 60_000 })),
      )
      const keys = results.map((r) => r.stdout.trim().split('\n').pop())
      expect(keys[0]).toMatch(/^[0-9a-f]{64}$/)
      expect(new Set(keys).size).toBe(1)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 90_000)
})
