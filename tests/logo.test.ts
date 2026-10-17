import { describe, expect, it } from 'vitest'
import { LOGO_GRID, logoCells, logoText } from '../src/tui/logo.js'

describe('terminal mark', () => {
  it('is a 17 x 16 grid made only of B, W, D and .', () => {
    expect(LOGO_GRID).toHaveLength(16)
    for (const row of LOGO_GRID) {
      expect(row).toHaveLength(17)
      expect(row).toMatch(/^[BWD.]+$/)
    }
  })

  it('is mirror-symmetric left to right', () => {
    for (const row of LOGO_GRID) expect(row).toBe([...row].reverse().join(''))
  })

  it('has a rounded tile: corners are empty, edges are not', () => {
    expect(LOGO_GRID[0]!.startsWith('..')).toBe(true)
    expect(LOGO_GRID[1]!.startsWith('.B')).toBe(true)
    expect(LOGO_GRID[8]![0]).toBe('B')
    expect(LOGO_GRID[15]!.endsWith('..')).toBe(true)
  })

  it('draws a V with arms sloping 1:2, a notch closing after four rows, one empty row, then the detached tip', () => {
    const v = LOGO_GRID.map((r) => (r.match(/W/g) ?? []).length)
    expect(v).toEqual([0, 0, 0, 8, 8, 8, 8, 7, 7, 5, 0, 0, 0, 0, 0, 0])
    const left = LOGO_GRID.map((r) => r.indexOf('W')).filter((i) => i >= 0)
    expect(left).toEqual([3, 3, 4, 4, 5, 5, 6])
    const tip = LOGO_GRID.map((r) => (r.match(/D/g) ?? []).length)
    expect(tip).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 3, 1, 0, 0])
    expect(LOGO_GRID[10]).toBe('B'.repeat(17)) // the gap
  })

  it('renders as 8 terminal rows; mixed pairs use foreground and background', () => {
    const cells = logoCells()
    expect(cells).toHaveLength(8)
    for (const row of cells) expect(row).toHaveLength(17)
    expect(cells.flat().some((c) => c.fg === 'v' && c.bg === 'tile')).toBe(true)
    expect(cells.flat().some((c) => c.fg === 'tip' && c.bg === 'tile')).toBe(true)
    expect(logoText()).toHaveLength(8)
  })
})
