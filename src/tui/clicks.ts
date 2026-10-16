import { useEffect, useRef, type RefObject } from 'react'
import type { DOMElement } from 'ink'

/**
 * Ink draws text and has no idea where the mouse is. A component that wants to be clickable registers its box here;
 * a click is matched against where the box was last laid out (yoga's computed offsets, summed up the tree).
 */
interface Region {
  ref: RefObject<DOMElement | null>
  onClick: () => void
}

const regions = new Set<Region>()

/** Absolute position of a node in the terminal grid (0-based), or null while it is not laid out. */
export function rectOf(node: DOMElement | null | undefined): { x: number; y: number; width: number; height: number } | null {
  if (!node?.yogaNode) return null
  let x = 0
  let y = 0
  let cur: DOMElement | undefined = node
  while (cur) {
    if (!cur.yogaNode) return null
    x += cur.yogaNode.getComputedLeft()
    y += cur.yogaNode.getComputedTop()
    cur = cur.parentNode
  }
  return { x, y, width: node.yogaNode.getComputedWidth(), height: node.yogaNode.getComputedHeight() }
}

/** Make a box clickable for as long as it is on screen. `onClick` may change every render. */
export function useClickable(ref: RefObject<DOMElement | null>, onClick: () => void): void {
  const latest = useRef(onClick)
  latest.current = onClick
  useEffect(() => {
    const region: Region = { ref, onClick: () => latest.current() }
    regions.add(region)
    return () => void regions.delete(region)
  }, [ref])
}

/** A click at (x, y), 0-based. The most recently added matching region wins. Returns whether anything took it. */
export function dispatchClick(x: number, y: number): boolean {
  let hit: Region | undefined
  for (const r of regions) {
    const rect = rectOf(r.ref.current)
    if (rect && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height) hit = r
  }
  hit?.onClick()
  return !!hit
}

/** SGR mouse report for a left-button PRESS (not release, not wheel, not drag): 1-based column and row. */
export function parseClick(raw: string): { x: number; y: number } | null {
  const m = /\[<0;(\d+);(\d+)M/.exec(raw)
  return m ? { x: Number(m[1]) - 1, y: Number(m[2]) - 1 } : null
}
