import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

let home: string
let vault: typeof import('../src/security/vault.js')

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'vara-vault-'))
  vault = await import('../src/security/vault.js')
})

afterAll(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('secret vault', () => {
  it('stores and returns secrets for scope, encrypting at rest', async () => {
    await vault.setSecret('GITHUB_TOKEN', 'ghp_0123456789abcdefghij', 'session:s1')
    const scoped = await vault.getSecretsForScope('session:s1')
    expect(scoped['GITHUB_TOKEN']).toBe('ghp_0123456789abcdefghij')

    // Not visible to another session
    const other = await vault.getSecretsForScope('session:s2')
    expect(other['GITHUB_TOKEN']).toBeUndefined()
  })

  it('global secrets are visible everywhere', async () => {
    await vault.setSecret('OPENAI_API_KEY', 'sk-global-key-000111222', 'global')
    const scoped = await vault.getSecretsForScope('session:anything')
    expect(scoped['OPENAI_API_KEY']).toBe('sk-global-key-000111222')
  })

  it('never stores the plaintext value on disk', async () => {
    const { readFile } = await import('node:fs/promises')
    const raw = await readFile(join(process.env['VARA_HOME']!, 'vault', 'secrets.json'), 'utf8')
    expect(raw).not.toContain('ghp_0123456789')
    expect(raw).not.toContain('sk-global-key')
  })

  it('lists and deletes secrets', async () => {
    const list = await vault.listSecrets()
    expect(list.map((s) => s.name)).toContain('GITHUB_TOKEN')
    expect(await vault.deleteSecret('GITHUB_TOKEN', 'session:s1')).toBe(true)
    expect((await vault.getSecretsForScope('session:s1'))['GITHUB_TOKEN']).toBeUndefined()
  })
})
