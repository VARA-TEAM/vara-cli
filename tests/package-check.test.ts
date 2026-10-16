import { describe, expect, it } from 'vitest'
import { maliciousPackages, packagesIn } from '../src/tools/package-check.js'

describe('package check', () => {
  it('reads package names out of install commands and skips flags, paths and URLs', () => {
    expect(packagesIn('npm install -D vitest@2 @types/node left-pad && echo hi')).toEqual([
      { ecosystem: 'npm', name: 'vitest' },
      { ecosystem: 'npm', name: '@types/node' },
      { ecosystem: 'npm', name: 'left-pad' },
    ])
    expect(packagesIn('pip install requests[socks]==2.0 -r req.txt ./local https://x.y/z.whl')).toEqual([{ ecosystem: 'PyPI', name: 'requests' }])
    expect(packagesIn('cargo add serde@1')).toEqual([{ ecosystem: 'crates.io', name: 'serde' }])
    expect(packagesIn('ls -la')).toEqual([])
  })
  it('flags only malware advisories, and never blocks when OSV cannot be reached', async () => {
    const osv = (async (_u: unknown, init?: { body?: string }) => {
      const name = (JSON.parse(init!.body!) as { package: { name: string } }).package.name
      const vulns = name === 'evil-pkg' ? [{ id: 'MAL-2024-1' }] : name === 'old-lib' ? [{ id: 'GHSA-xxxx' }] : []
      return new Response(JSON.stringify({ vulns }), { status: 200 })
    }) as unknown as typeof fetch
    const found = await maliciousPackages('npm i evil-pkg old-lib fine', { fetchImpl: osv })
    expect(found).toEqual([{ ecosystem: 'npm', name: 'evil-pkg', advisory: 'MAL-2024-1' }])
    const down = (async () => {
      throw new Error('offline')
    }) as unknown as typeof fetch
    expect(await maliciousPackages('npm i evil-pkg', { fetchImpl: down })).toEqual([])
  })
})
