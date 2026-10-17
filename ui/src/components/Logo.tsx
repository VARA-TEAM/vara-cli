import { useId } from 'react'

/**
 * VARA's mark and name, built from exact geometry (no images, no effects).
 *
 * The mark is always shown on its violet tile (radius 22%): an ivory capital V on a 100 x 100 grid, arms sloping 1:2 and
 * 30 units thick, whose tip is detached by one clean gap. The tip is a deep shade of the tile colour, so it reads as the
 * checkpoint you can return to without adding a second bright colour. The tile follows the theme's brand colour.
 * Small sizes (24 px and below) use a second drawing with thicker arms and a wider gap so the cut survives.
 * Do not add glow, gradients, stars or ornaments: the identity is the geometry.
 */

const BIG = { top: '0,0 30,0 50,40 70,0 100,0 67.5,65 32.5,65', tip: '36,72 64,72 50,100' }
const SMALL = { top: '0,0 34,0 50,32 66,0 100,0 70,60 30,60', tip: '36,72 64,72 50,100' }

export function LogoMark({ size = 32, className }: { size?: number; className?: string }) {
  const g = size <= 24 ? SMALL : BIG
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className={className} aria-hidden="true" focusable="false">
      <rect width="100" height="100" rx="22" fill="var(--brand)" />
      <g transform="translate(22 25) scale(.56)">
        <polygon points={g.top} fill="#F4F1FF" />
        <polygon points={g.tip} fill="#1B1240" style={{ fill: 'color-mix(in srgb, var(--brand) 20%, #000)' }} />
      </g>
    </svg>
  )
}

/** The name, drawn: V and A are 106 wide with flat-trimmed apexes and no crossbar in the A; stroke is 22% of the height. */
export function Wordmark({ height = 14, className }: { height?: number; className?: string }) {
  const clip = `w${useId().replace(/:/g, '')}`
  return (
    <svg viewBox="0 0 406 100" height={height} width={(height * 406) / 100} className={className} role="img" aria-label="VARA" fill="currentColor">
      <defs>
        <clipPath id={clip}>
          <rect width="406" height="100" />
        </clipPath>
      </defs>
      <polygon points="0,0 24.6,0 53,56.8 81.4,0 106,0 56,100 50,100" />
      <polygon points="74,100 98.6,100 127,43.2 155.4,100 180,100 130,0 124,0" />
      <g clipPath={`url(#${clip})`} fill="none" stroke="currentColor" strokeWidth="22" strokeLinejoin="miter" strokeMiterlimit="10">
        <path d="M205,0V100M205,11H260L273,24V43L260,56H205M236,56L275,100" />
      </g>
      <polygon points="300,100 324.6,100 353,43.2 381.4,100 406,100 356,0 350,0" />
    </svg>
  )
}
