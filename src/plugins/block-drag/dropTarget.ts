/**
 * DOM adapter for the drop projection: from the element under the pointer
 * to a move target and the line that shows it. Reads rendered rows only —
 * their order, nesting and geometry — and leaves the data model to
 * `moveBlocksTo`, whose transaction re-checks everything (cycle, missing
 * parent, workspace) when the drop lands.
 */
import { BLOCK_BULLET_ATTRIBUTE, BLOCK_SHELL_ATTRIBUTE } from '@/extensions/blockInteraction.js'
import { isPanelRenderScopeId } from '@/utils/renderScope.js'
import type { MoveTarget } from '@/plugins/move-blocks'
import { findSlot, projectDrop, type DropRow, type SlotRows } from './projection.ts'

/** A mounted row. Deferred rows' placeholders carry the shell attribute
 *  but no `data-block-id`, so they never match. */
export const ROW_SELECTOR = `[${BLOCK_SHELL_ATTRIBUTE}][data-block-id][data-render-scope-id]`
const PANEL_SELECTOR = '[data-panel-id]'

/** The default layout's per-level indent, for a surface with no nested
 *  row to measure it from. */
const FALLBACK_INDENT_PX = 36

export interface DropLine {
  readonly x: number
  readonly y: number
  readonly width: number
}

export interface DropTarget {
  readonly move: MoveTarget
  readonly line: DropLine
  readonly renderScopeId: string
  readonly panelId: string | null
}

export interface DropContext {
  /** The blocks being dragged (before descendant pruning). */
  readonly draggedIds: ReadonlySet<string>
  /** May the surface rooted at `rootId` take a drop? Covers what the DOM
   *  can't see: a panel zoomed into a descendant of a dragged block. A
   *  surface whose answer isn't known yet reports false. */
  isSurfaceAllowed(rootId: string): boolean
}

/**
 * Where a drop at (`x`, `y`) would land, given `hit` — the element under
 * the pointer. Null when there is no valid target: off any row, over a
 * dragged row, or on a surface that isn't a panel's own outline.
 *
 * v1: drops land only in a panel's own outline, never inside an embed,
 * a backlink entry or another nested surface.
 */
export const resolveDropTarget = (
  hit: Element | null,
  x: number,
  y: number,
  context: DropContext,
): DropTarget | null => {
  // Off every row but inside a panel (its margin, left of the outline
  // while dragging out to outdent): the panel's own outline.
  const hovered = hit?.closest<HTMLElement>(ROW_SELECTOR) ?? panelOutlineRoot(hit?.closest(PANEL_SELECTOR))
  const renderScopeId = hovered?.dataset.renderScopeId
  if (!hovered || !renderScopeId || !isPanelRenderScopeId(renderScopeId)) return null

  const panel = hovered.closest<HTMLElement>(PANEL_SELECTOR)
  const surface = surfaceRows(panel ?? hovered.ownerDocument, renderScopeId, context)
  const rootId = surface.rowId(0)
  if (!rootId || !context.isSurfaceAllowed(rootId)) return null

  const slot = findSlot(surface, y)
  if (!slot) return null

  const indent = measureIndent(panel ?? hovered.ownerDocument, renderScopeId)
  const above = surface.dropRow(slot.above)
  const below = slot.below === null ? null : surface.dropRow(slot.below)
  const projection = projectDrop(above, below, x, indent)

  // The line starts at the projected depth's column. The root has no
  // bullet, so its column is read off the row below it when it is above.
  const reference = slot.above === 0 && below ? below : above
  const lineX = reference.x + (projection.depth - reference.depth) * indent
  return {
    move: {parentId: projection.parentId, position: projection.position},
    line: {x: lineX, y: surface.ownBottom(slot.above), width: Math.max(0, surface.right - lineX)},
    renderScopeId,
    panelId: panel?.dataset.panelId ?? null,
  }
}

interface SurfaceRows extends SlotRows {
  rowId(index: number): string | undefined
  dropRow(index: number): DropRow
  /** Right edge of the surface root, where the drop line ends. */
  readonly right: number
}

/** One surface's rows in document order, with rects and DOM ancestry read
 *  lazily and cached for this lookup only — rows move between frames. */
const surfaceRows = (
  container: ParentNode,
  renderScopeId: string,
  context: DropContext,
): SurfaceRows => {
  const rows = Array.from(container.querySelectorAll<HTMLElement>(scopedRowSelector(renderScopeId)))
  const rects = new Map<number, DOMRect>()
  const rect = (i: number): DOMRect => {
    let cached = rects.get(i)
    if (!cached) rects.set(i, cached = rows[i].getBoundingClientRect())
    return cached
  }
  const chains = new Map<number, string[]>()
  /** Ids of the row's same-scope ancestors, root first. */
  const chain = (i: number): string[] => {
    let cached = chains.get(i)
    if (!cached) chains.set(i, cached = ancestorIdsOf(rows[i], renderScopeId))
    return cached
  }
  const ownBottom = (i: number): number =>
    i + 1 < rows.length && rows[i].contains(rows[i + 1]) ? rect(i + 1).top : rect(i).bottom

  return {
    count: rows.length,
    top: i => rect(i).top,
    ownBottom,
    bottom: i => rect(i).bottom,
    // DOM containment: the row is a dragged block, or rendered inside one.
    isExcluded: i => context.draggedIds.has(rows[i].dataset.blockId!)
      || chain(i).some(id => context.draggedIds.has(id)),
    rowId: i => rows[i]?.dataset.blockId,
    dropRow: i => ({
      id: rows[i].dataset.blockId!,
      depth: chain(i).length,
      ancestorIds: chain(i),
      x: bulletX(rows[i]) ?? rect(i).left,
    }),
    get right() { return rows.length ? rect(0).right : 0 },
  }
}

const panelOutlineRoot = (panel: Element | null | undefined): HTMLElement | null => {
  if (!panel) return null
  for (const row of panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
    if (isPanelRenderScopeId(row.dataset.renderScopeId!)) return row
  }
  return null
}

const scopedRowSelector = (renderScopeId: string): string =>
  `${ROW_SELECTOR}[data-render-scope-id="${CSS.escape(renderScopeId)}"]`

const ancestorIdsOf = (row: HTMLElement, renderScopeId: string): string[] => {
  const ids: string[] = []
  let current = row.parentElement?.closest<HTMLElement>(ROW_SELECTOR)
  while (current && current.dataset.renderScopeId === renderScopeId) {
    ids.push(current.dataset.blockId!)
    current = current.parentElement?.closest<HTMLElement>(ROW_SELECTOR)
  }
  return ids.reverse()
}

/** Centre x of the row's OWN bullet; null for a row without one (a
 *  panel's root renders as a title). */
const bulletX = (row: HTMLElement): number | null => {
  const bullet = row.querySelector<HTMLElement>(`[${BLOCK_BULLET_ATTRIBUTE}]`)
  if (!bullet || bullet.closest(ROW_SELECTOR) !== row) return null
  const rect = bullet.getBoundingClientRect()
  return rect.left + rect.width / 2
}

/** The surface's per-level indent: the bullet offset between any row at
 *  depth ≥ 2 and its parent (depth-1 rows sit flush with the root, so they
 *  can't be measured against it). */
const measureIndent = (container: ParentNode, renderScopeId: string): number => {
  const row = scopedRowSelector(renderScopeId)
  const nested = container.querySelector<HTMLElement>(`${row} ${row} ${row}`)
  const parent = nested?.parentElement?.closest<HTMLElement>(ROW_SELECTOR)
  const childX = nested && bulletX(nested)
  const parentX = parent && bulletX(parent)
  return childX != null && parentX != null && childX > parentX ? childX - parentX : FALLBACK_INDENT_PX
}
