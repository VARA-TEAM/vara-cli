/**
 * The VARA mark for the terminal: the violet tile with the tipped V, drawn by hand on a 17 x 16 grid (never traced from
 * an image). It is the same drawing as the web mark: an ivory V whose arms slope 1:2 (one pixel in, every two rows),
 * a notch 4 rows deep, one empty row, and the detached tip. Each terminal row holds two pixel rows (half blocks), so
 * the mark is 17 columns wide and 8 rows tall, close to square.
 *
 * `B` tile (the theme's brand colour), `W` the V (ivory), `D` the tip (deep violet), `.` outside the rounded tile.
 */
export const LOGO_GRID: readonly string[] = [
  '..BBBBBBBBBBBBB..',
  '.BBBBBBBBBBBBBBB.',
  'BBBBBBBBBBBBBBBBB',
  'BBBWWWWBBBWWWWBBB',
  'BBBWWWWBBBWWWWBBB',
  'BBBBWWWWBWWWWBBBB',
  'BBBBWWWWBWWWWBBBB',
  'BBBBBWWWWWWWBBBBB',
  'BBBBBWWWWWWWBBBBB',
  'BBBBBBWWWWWBBBBBB',
  'BBBBBBBBBBBBBBBBB',
  'BBBBBBBDDDBBBBBBB',
  'BBBBBBBDDDBBBBBBB',
  'BBBBBBBBDBBBBBBBB',
  '.BBBBBBBBBBBBBBB.',
  '..BBBBBBBBBBBBB..',
]

export type LogoRole = 'tile' | 'v' | 'tip'

export interface LogoCell {
  ch: ' ' | '▀' | '▄' | '█'
  fg: LogoRole | null
  bg: LogoRole | null
}

const roleOf = (c: string | undefined): LogoRole | null => (c === 'B' ? 'tile' : c === 'W' ? 'v' : c === 'D' ? 'tip' : null)

/** Pairs pixel rows into half-block cells; two different colours in one cell use foreground and background together. */
export function logoCells(grid: readonly string[] = LOGO_GRID): LogoCell[][] {
  const rows: LogoCell[][] = []
  for (let y = 0; y < grid.length; y += 2) {
    const upper = grid[y] ?? ''
    const lower = grid[y + 1] ?? ''
    const row: LogoCell[] = []
    for (let x = 0; x < upper.length; x++) {
      const u = roleOf(upper[x])
      const l = roleOf(lower[x])
      if (!u && !l) row.push({ ch: ' ', fg: null, bg: null })
      else if (u === l) row.push({ ch: '█', fg: u, bg: null })
      else if (!l) row.push({ ch: '▀', fg: u, bg: null })
      else if (!u) row.push({ ch: '▄', fg: l, bg: null })
      else row.push({ ch: '▀', fg: u, bg: l })
    }
    rows.push(row)
  }
  return rows
}

/** Plain text, for places that cannot colour (logs, tests). */
export function logoText(grid: readonly string[] = LOGO_GRID): string[] {
  return logoCells(grid).map((r) => r.map((c) => c.ch).join('').replace(/\s+$/, ''))
}
