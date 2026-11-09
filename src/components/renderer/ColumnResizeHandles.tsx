import {useLayoutEffect, useRef, useState} from 'react'
import {resizeColumnPair} from '@/utils/layoutColumns.js'

export interface LayoutColumn {
  id: string
  weight: number
}

export type ColumnWeights = ReadonlyMap<string, number>

interface ColumnResizeHandlesProps {
  /** The positioned grid whose direct children carry `data-layout-column-id`.
   *  An element, not a ref: a parent's ref is attached after its children's
   *  layout effects run. */
  container: HTMLElement
  columns: readonly LayoutColumn[]
  /** The weights a drag in flight asks for; null once it is over. */
  onDrag: (weights: ColumnWeights | null) => void
  onCommit: (weights: ColumnWeights) => void
  /** Back to equal shares for the two columns beside a divider. */
  onReset: (ids: readonly [string, string]) => void
}

/** The grid's own column minimum, `minmax(24rem, …)` in `LayoutRenderer`. */
const MIN_COLUMN_REM = 24
const HANDLE_WIDTH_PX = 8
/** How far a press moves before it is a drag; a click's jitter is not. */
const DRAG_THRESHOLD_PX = 3

const columnElement = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`:scope > [data-layout-column-id="${CSS.escape(id)}"]`)

interface Drag {
  pointerId: number
  x: number
  ids: readonly [string, string]
  widths: readonly [number, number]
  weights: readonly [number, number]
  latest: ColumnWeights | null
}

/** A drag strip over each divider between layout columns. Outside the
 *  columns, in the grid itself, so a column that scrolls (a stack) doesn't
 *  carry its strip away; placed from the columns' measured offsets. */
export function ColumnResizeHandles({container, columns, onDrag, onCommit, onReset}: ColumnResizeHandlesProps) {
  const [dividers, setDividers] = useState<readonly number[]>([])
  const drag = useRef<Drag | null>(null)
  const ids = columns.map(column => column.id).join('\u0000')

  useLayoutEffect(() => {
    const elements = ids.split('\u0000').map(id => columnElement(container, id))
    const measure = () => {
      const next = elements.slice(1).map(el => el?.offsetLeft ?? -1)
      setDividers(current => current.length === next.length && current.every((x, i) => x === next[i]) ? current : next)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(container)
    for (const el of elements) if (el) observer.observe(el)
    measure()
    return () => observer.disconnect()
  }, [container, ids])

  const end = (commit: boolean) => {
    const current = drag.current
    drag.current = null
    if (commit && current?.latest) onCommit(current.latest)
    else onDrag(null)
  }

  return dividers.map((x, index) => {
    const left = columns[index]
    const right = columns[index + 1]
    if (x < 0 || !left || !right) return null
    return (
      <div
        key={`${left.id}\u0000${right.id}`}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize columns"
        title="Drag to resize; double-click for equal widths"
        onPointerDown={event => {
          if (event.button !== 0) return
          const leftEl = columnElement(container, left.id)
          const rightEl = columnElement(container, right.id)
          if (!leftEl || !rightEl) return
          event.preventDefault()
          drag.current = {
            pointerId: event.pointerId,
            x: event.clientX,
            ids: [left.id, right.id],
            widths: [leftEl.getBoundingClientRect().width, rightEl.getBoundingClientRect().width],
            weights: [left.weight, right.weight],
            latest: null,
          }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={event => {
          const current = drag.current
          if (!current || current.pointerId !== event.pointerId) return
          const dx = event.clientX - current.x
          if (!current.latest && Math.abs(dx) < DRAG_THRESHOLD_PX) return
          const minWidth = MIN_COLUMN_REM * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)
          const [a, b] = resizeColumnPair({widths: current.widths, weights: current.weights, dx, minWidth})
          current.latest = new Map([[current.ids[0], a], [current.ids[1], b]])
          onDrag(current.latest)
        }}
        onPointerUp={() => end(true)}
        onPointerCancel={() => end(false)}
        // After a pointerup has ended the drag; this is a capture lost without one.
        onLostPointerCapture={() => { if (drag.current) end(false) }}
        onDoubleClick={() => onReset([left.id, right.id])}
        className="group absolute inset-y-0 z-20 flex cursor-col-resize touch-none justify-center"
        style={{left: x - HANDLE_WIDTH_PX / 2, width: HANDLE_WIDTH_PX}}
      >
        <div className="h-full w-px bg-transparent transition-colors group-hover:bg-ring group-active:bg-ring"/>
      </div>
    )
  })
}
