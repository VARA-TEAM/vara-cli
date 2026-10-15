import { describe, expect, it } from 'vitest'
import { collapseRepeats, compressToolOutput, queryOutput, shrinkForCompaction, stripAnsi } from '../src/core/outputs.js'

function noisyTestLog(): string {
  const lines: string[] = []
  for (let i = 0; i < 600; i++) lines.push(` ok suite${i % 40} passes case ${i} (3ms)`)
  lines.splice(300, 0, 'FAIL tests/store.test.ts > saves atomically', 'AssertionError: expected 3 to be 4', '    at tests/store.test.ts:88:21')
  lines.push('Tests  1 failed | 599 passed (600)')
  return lines.join('\n')
}

describe('tool output compression', () => {
  it('keeps the start, the end and the error lines of a long log, and is much smaller', () => {
    const log = noisyTestLog()
    const c = compressToolOutput(log, 3000, 'call_9')
    expect(c.compressed).toBe(true)
    expect(c.text.length).toBeLessThan(3300)
    expect(c.text.length).toBeLessThan(log.length / 5)
    expect(c.text).toContain('FAIL tests/store.test.ts')
    expect(c.text).toContain('AssertionError: expected 3 to be 4')
    expect(c.text).toContain('Tests  1 failed | 599 passed')
    expect(c.text).toContain('tool_output')
    expect(c.text).toContain('call_9')
  })

  it('leaves short output alone and strips terminal colour codes', () => {
    const c = compressToolOutput('\u001b[32mok\u001b[0m done', 3000)
    expect(c.text).toBe('ok done')
    expect(c.compressed).toBe(false)
  })

  it('collapses runs of identical lines', () => {
    expect(collapseRepeats(['a', 'x', 'x', 'x', 'x', 'b'])).toEqual(['a', 'x  [x4]', 'b'])
    expect(stripAnsi('\u001b[1mB\u001b[0m')).toBe('B')
  })

  it('the model can get the rest: head, tail, range and grep over the stored text', () => {
    const log = noisyTestLog()
    expect(queryOutput(log, { grep: 'AssertionError' })).toContain('expected 3 to be 4')
    expect(queryOutput(log, { tail: 2 })).toContain('599 passed')
    expect(queryOutput(log, { from: 1, to: 2 })).toContain('suite0')
    expect(queryOutput(log, { grep: 'nothing-like-this' })).toContain('(nothing matched)')
    expect(queryOutput(log, { head: 3 }).split('\n').length).toBeLessThan(6)
  })

  it('an invalid regex does not crash the retrieval', () => {
    expect(queryOutput('a(b\nc', { grep: '(' })).toContain('a(b')
  })

  it('compaction keeps the error lines of an old result', () => {
    const log = noisyTestLog()
    const shrunk = shrinkForCompaction(log, log.length)
    expect(shrunk).toContain('AssertionError')
    expect(shrunk).toContain('removed to save cost')
    expect(shrunk.length).toBeLessThan(1500)
  })
})
