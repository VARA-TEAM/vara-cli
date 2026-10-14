import { describe, expect, it } from 'vitest'

/**
 * Regression: launched from PowerShell 7, PSModulePath points at PowerShell 7's
 * modules and the child Windows PowerShell cannot load ConvertTo-SecureString.
 * The vault must keep working with such an environment (Windows only).
 */
describe.skipIf(process.platform !== 'win32')('vault under a PowerShell 7 style environment', () => {
  it('still protects and unprotects the master key', async () => {
    const saved = process.env['PSModulePath']
    process.env['PSModulePath'] = 'C:/Program Files/PowerShell/7/Modules'
    try {
      const vault = await import('../src/security/vault.js')
      await vault.setSecret('ENV_TEST', 'value-123')
      expect((await vault.getSecretsForScope('global'))['ENV_TEST']).toBe('value-123')
    } finally {
      if (saved === undefined) delete process.env['PSModulePath']
      else process.env['PSModulePath'] = saved
    }
  })
})
