import {useRef, type CSSProperties} from 'react'

/** How far a press moves before it is a drag; a click's jitter is not. */
const DRAG_THRESHOLD_PX = 3
export const DIVIDER_HANDLE_WIDTH_PX = 8

export interface DividerDrag {
  /** A press on the divider; false refuses it. */
  onStart?: () => boolean
  /** The pointer is `dx` px right of where it was pressed, once it has moved
   *  past a click's jitter. */
  onMove: (dx: number) => void
  /** Released after moving. A press that never moved ends with neither this
   *  nor `onCancel`. */
  onEnd: () => void
  /** Taken away after moving (pointercancel, or capture lost without a
   *  release): whatever `onMove` showed is to be undone. */
  onCancel: () => void
}

interface DividerHandleProps {
  drag: DividerDrag
  /** Double-click: back to the automatic or even width. */
  onReset: () => void
  label: string
  title: string
  /** Where the strip goes; it is `DIVIDER_HANDLE_WIDTH_PX` wide. */
  style: CSSProperties
}

/** A vertical drag strip, transparent until hovered: the one pointer protocol
 *  for dragging a divider (capture, threshold, release, cancel). */
export function DividerHandle({drag, onReset, label, title, style}: DividerHandleProps) {
  const press = useRef<{pointerId: number; x: number; moved: boolean} | null>(null)
  const finish = (then: () => void) => (event: {pointerId: number}) => {
    const current = press.current
    if (!current || current.pointerId !== event.pointerId) return
    press.current = null
    if (current.moved) then()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={title}
      onPointerDown={event => {
        if (event.button !== 0 || drag.onStart?.() === false) return
        event.preventDefault()
        press.current = {pointerId: event.pointerId, x: event.clientX, moved: false}
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        const current = press.current
        if (!current || current.pointerId !== event.pointerId) return
        const dx = event.clientX - current.x
        if (!current.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
        current.moved = true
        drag.onMove(dx)
      }}
      onPointerUp={finish(drag.onEnd)}
      onPointerCancel={finish(drag.onCancel)}
      // After a pointerup has finished the press; this is a capture lost
      // without one.
      onLostPointerCapture={finish(drag.onCancel)}
      onDoubleClick={onReset}
      className="group absolute z-20 flex cursor-col-resize touch-none justify-center"
      style={{...style, width: DIVIDER_HANDLE_WIDTH_PX}}
    >
      <div className="h-full w-px bg-transparent transition-colors group-hover:bg-ring group-active:bg-ring"/>
    </div>
  )
}
