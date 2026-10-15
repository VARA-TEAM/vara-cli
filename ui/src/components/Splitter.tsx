import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

/**
 * A drag handle between two panes. It is a real ARIA separator: focusable, announces its size,
 * resizes with the arrow keys (Shift = big step, Home/End = limits, Enter = reset) and resets on
 * double click. Dragging uses pointer capture, so it keeps working when the pointer leaves the handle
 * or crosses an iframe (the body gets `wb-dragging`, which switches iframe hit-testing off).
 */
export function Splitter({
  orientation,
  label,
  now,
  min,
  max,
  start,
  onMove,
  onKey,
  onReset,
  className,
}: {
  /** `vertical` = a vertical bar that resizes widths; `horizontal` = a horizontal bar that resizes heights. */
  orientation: 'vertical' | 'horizontal'
  label: string
  now: number
  min: number
  max: number
  /** Value at the moment a drag begins. */
  start: () => number
  /** Called while dragging with the pointer movement since the drag began. */
  onMove: (startValue: number, dx: number, dy: number) => void
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void
  onReset: () => void
  className?: string
}) {
  const drag = useRef<{ x: number; y: number; v: number } | null>(null)

  const down = (e: PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { x: e.clientX, y: e.clientY, v: start() }
    document.body.classList.add('wb-dragging', orientation === 'vertical' ? 'wb-dragging-x' : 'wb-dragging-y')
    e.preventDefault()
  }
  const move = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d) onMove(d.v, e.clientX - d.x, e.clientY - d.y)
  }
  const up = (e: PointerEvent<HTMLDivElement>): void => {
    if (!drag.current) return
    drag.current = null
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    document.body.classList.remove('wb-dragging', 'wb-dragging-x', 'wb-dragging-y')
  }

  return (
    <div
      role="separator"
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      aria-label={label}
      aria-valuenow={Math.round(now)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      className={`splitter splitter-${orientation}${className ? ` ${className}` : ''}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onLostPointerCapture={() => {
        drag.current = null
        document.body.classList.remove('wb-dragging', 'wb-dragging-x', 'wb-dragging-y')
      }}
      onDoubleClick={onReset}
      onKeyDown={onKey}
      title={label}
    />
  )
}
