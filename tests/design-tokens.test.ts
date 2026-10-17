import { describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { THEMES, ACCENTS, inkOf } from '../design/tokens.mjs'

describe('design tokens', () => {
  it('every surface carries the generated stylesheet, byte for byte', () => {
    expect(() => execFileSync('node', ['scripts/build-tokens.mjs', '--check'], { stdio: 'pipe' })).not.toThrow()
  })

  it('light and dark answer the same questions', () => {
    expect(Object.keys(THEMES.light).sort()).toEqual(Object.keys(THEMES.dark).sort())
  })

  it('every accent keeps its text readable (at least 4.5:1) in both themes', () => {
    const lum = (hex: string): number => {
      const n = parseInt(hex.slice(1), 16)
      const f = (c: number): number => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f((n >> 16) & 255) + 0.7152 * f((n >> 8) & 255) + 0.0722 * f(n & 255)
    }
    const ratio = (a: string, b: string): number => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05)
    for (const [name, a] of Object.entries(ACCENTS)) {
      for (const mode of ['dark', 'light'] as const) expect(ratio(a[mode], inkOf(a, mode)), `${name} ${mode}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
