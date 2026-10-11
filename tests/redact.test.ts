import { describe, expect, it } from 'vitest'
import { registerSecret, scrub, scrubAll, clearSecrets } from '../src/security/redact.js'

describe('redaction', () => {
  it('replaces registered secret values everywhere', () => {
    clearSecrets()
    registerSecret('super-secret-token-1234', 'GITHUB_TOKEN')
    const out = scrub('export GITHUB_TOKEN=super-secret-token-1234 and again super-secret-token-1234')
    expect(out).not.toContain('super-secret-token-1234')
    expect(out).toContain('⟦GITHUB_TOKEN⟧')
  })

  it('catches credentials embedded in URLs', () => {
    clearSecrets()
    registerSecret('hunter2hunter2', 'DB_PASSWORD')
    const out = scrub('postgres://admin:hunter2hunter2@db:5432/app')
    expect(out).not.toContain('hunter2hunter2')
  })

  it('ignores very short values to avoid false positives', () => {
    clearSecrets()
    registerSecret('abc', 'TOO_SHORT')
    expect(scrub('abcdefg')).toBe('abcdefg')
  })

  it('scrubs well-known token shapes without registration', () => {
    clearSecrets()
    expect(scrubAll('token ghp_abcdefghijklmnop1234567890abcd')).not.toContain('ghp_')
    expect(scrubAll('Authorization: Bearer abcdefghijklmnopqrstuv')).not.toContain('Bearer abcdefghijklmnopqrstuv')
  })
})
