/**
 * Pure drop geometry for block drag-and-drop: which gap between two
 * visible rows the pointer is in ({@link findSlot}), and which depth —
 * hence which parent and position — that gap means at the pointer's x
 * ({@link projectDrop}). The DOM adapter (`dropTarget.ts`) feeds both from
 * the rendered rows; nothing here reads the DOM or the database.
 */
import type { InsertPosition } from '@/data/mutators.js'

/** A visible row, as the projection needs it. Depth is relative to the
 *  surface: 0 is the surface's root (a panel's top-level block). */
export interface DropRow {
  readonly id: string
  readonly depth: number
  /** `ancestorIds[d]` is this row's ancestor at depth `d`, root first;
   *  its length is `depth`. */
  readonly ancestorIds: readonly string[]
  /** The x of this row's depth column. The pointer over the same column
   *  means "this depth"; each `indentWidth` further right or left is one
   *  level deeper or shallower. */
  readonly x: number
}

export interface DropProjection {
  readonly depth: number
  readonly parentId: string
  readonly position: InsertPosition
}

/**
 * The standard tree drag-and-drop projection. The gap between `above`
 * and `below` can hold any depth in `[depth(below), depth(above) + 1]`:
 * deeper would skip a level under `above`, shallower would split
 * `below` from the ancestors it is drawn under. The pointer's x picks
 * one, rounded to the nearest column.
 *
 * Never shallower than 1: the root has no sibling slot inside its own
 * surface. When `below` is `above`'s first child the range is a single
 * depth, so just below an expanded block with children is its first
 * child — the same answer paste's 'visible' placement gives.
 */
export const projectDrop = (
  above: DropRow,
  below: Pick<DropRow, 'depth'> | null,
  pointerX: number,
  indentWidth: number,
): DropProjection => {
  const maxDepth = above.depth + 1
  // The root is never `below` (it is the first row), so this is ≥ 1.
  const minDepth = below?.depth ?? 1
  const pointed = above.depth + Math.round((pointerX - above.x) / indentWidth)
  const depth = Math.min(maxDepth, Math.max(minDepth, pointed))

  if (depth === maxDepth) {
    return {depth, parentId: above.id, position: {kind: 'first'}}
  }
  // Shallower: land after `above`'s ancestor at that depth (or `above`
  // itself), inside that ancestor's parent.
  const chain = [...above.ancestorIds, above.id]
  return {depth, parentId: chain[depth - 1], position: {kind: 'after', siblingId: chain[depth]}}
}

/** A surface's rows in document order, read on demand so a lookup costs
 *  a binary search, not a pass over every rendered row. Index 0 is the
 *  surface root. */
export interface SlotRows {
  readonly count: number
  top(index: number): number
  /** Bottom of the row's OWN line — where its first rendered child
   *  starts, or its full height when it shows none. */
  ownBottom(index: number): number
  /** Bottom of the row including everything it renders below its line. */
  bottom(index: number): number
  /** The row is a dragged block or inside one. */
  isExcluded(index: number): boolean
}

export interface Slot {
  readonly above: number
  readonly below: number | null
}

/**
 * The gap the pointer at `y` is in: the row under it splits at its own
 * line's midpoint into the gap above it and the gap below it. Dragged
 * rows are skipped when picking the neighbours, and a pointer over one
 * has no slot at all, so no drop indicator shows inside a dragged
 * subtree. The gap above the root is never offered.
 */
export const findSlot = (rows: SlotRows, y: number): Slot | null => {
  if (rows.count === 0) return null
  const index = lastRowStartingAtOrAbove(rows, y)
  if (rows.isExcluded(index)) {
    // Past a dragged row's whole extent (it is the last row, dragged out
    // below the surface): the gap it leaves.
    if (y < rows.bottom(index)) return null
    const above = previousIncluded(rows, index)
    return above === null ? null : {above, below: nextIncluded(rows, index)}
  }

  const midpoint = (rows.top(index) + rows.ownBottom(index)) / 2
  if (y < midpoint && index > 0) {
    const above = previousIncluded(rows, index)
    return above === null ? null : {above, below: index}
  }
  return {above: index, below: nextIncluded(rows, index)}
}

/** Rows start in document order, top to bottom. Index 0 when `y` is
 *  above every row. */
const lastRowStartingAtOrAbove = (rows: SlotRows, y: number): number => {
  let low = 0
  let high = rows.count - 1
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (rows.top(mid) <= y) low = mid
    else high = mid - 1
  }
  return low
}

const previousIncluded = (rows: SlotRows, index: number): number | null => {
  for (let i = index - 1; i >= 0; i--) if (!rows.isExcluded(i)) return i
  return null
}

const nextIncluded = (rows: SlotRows, index: number): number | null => {
  for (let i = index + 1; i < rows.count; i++) if (!rows.isExcluded(i)) return i
  return null
}
