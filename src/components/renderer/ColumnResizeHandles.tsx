import {useLayoutEffect, useRef, useState} from 'react'
import {DividerHandle} from '@/components/DividerHandle.js'
import {equalizeColumnPair, resizeColumns} from '@/utils/layoutColumns.js'

export interface LayoutColumn {
  id: string
  weight: number
}

export type ColumnWeights = ReadonlyMap<string, number>

/** A layout column's minimum width, in rem; `LayoutRenderer` builds the grid's
 *  tracks from it. */
export const MIN_COLUMN_REM = 24

interface ColumnResizeHandlesProps {
  /** The positioned grid whose direct children carry `data-layout-column-id`.
   *  An element, not a ref: a parent's ref is attached after its children's
   *  layout effects run. */
  container: HTMLElement
  columns: readonly LayoutColumn[]
  /** Every column's weight while a drag is in flight; null once it is over. */
  onDrag: (weights: ColumnWeights | null) => void
  /** Every column's weight when a drag ends, or a double-click evens a pair. */
  onCommit: (weights: ColumnWeights) => void
}

const columnElement = (container: HTMLElement, id: string): HTMLElement | null =>
  container.querySelector<HTMLElement>(`:scope > [data-layout-column-id="${CSS.escape(id)}"]`)

interface Drag {
  /** Every column's rendered width when the drag started. */
  widths: readonly number[]
  minWidth: number
  latest: ColumnWeights | null
}

/** A drag strip over each divider between layout columns. Outside the
 *  columns, in the grid itself, so a column that scrolls (a stack) doesn't
 *  carry its strip away; placed from the columns' measured offsets, on the
 *  right column's border and padding, clear of the left column's scrollbar. */
export function ColumnResizeHandles({container, columns, onDrag, onCommit}: ColumnResizeHandlesProps) {
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
    return () => {
      observer.disconnect()
      // Its widths are by index into a column set that is gone.
      drag.current = null
    }
  }, [container, ids])

  const byColumn = (weights: readonly number[]): ColumnWeights =>
    new Map(columns.map((column, index) => [column.id, weights[index]]))

  return dividers.map((x, index) => {
    const divider = index + 1
    const left = columns[index]
    const right = columns[divider]
    if (x < 0 || !left || !right) return null
    return (
      <DividerHandle
        key={`${left.id}\u0000${right.id}`}
        label="Resize columns"
        title="Drag to resize; double-click for equal widths"
        style={{left: x, top: 0, bottom: 0}}
        drag={{
          onStart: () => {
            const elements = columns.map(column => columnElement(container, column.id))
            if (elements.some(el => !el)) return false
            drag.current = {
              widths: elements.map(el => el!.getBoundingClientRect().width),
              minWidth: MIN_COLUMN_REM * Number.parseFloat(getComputedStyle(document.documentElement).fontSize),
              latest: null,
            }
            return true
          },
          onMove: dx => {
            const current = drag.current
            if (!current) return
            current.latest = byColumn(resizeColumns({widths: current.widths, divider, dx, minWidth: current.minWidth}))
            onDrag(current.latest)
          },
          onEnd: () => {
            const latest = drag.current?.latest
            drag.current = null
            if (latest) onCommit(latest)
            else onDrag(null)
          },
          onCancel: () => {
            drag.current = null
            onDrag(null)
          },
        }}
        onReset={() => onCommit(byColumn(equalizeColumnPair(columns.map(column => column.weight), divider)))}
      />
    )
  })
}
