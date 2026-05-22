/**
 * Spatial-navigation walker — pure DOM queries, no in-memory registry.
 *
 * The DOM is the source of truth. At keypress time we query the relevant
 * subtree for tagged instances and walk in document order. This avoids
 * the registry-churn / re-render invisibility / stale-ref problems of the
 * old visual-navigation plugin.
 *
 * Tagging contract (set by the shell decorator + layout renderer):
 *
 *   Layout column wrapper: `data-layout-column-id="..."`
 *   Panel wrapper:         `data-panel-id="..."`
 *   Block shell:           `data-block-instance="<unique-per-mount key>"`
 *                          `data-block-id="<block.id>"`
 *                          `data-block-surface="outline|backlink|breadcrumb|embedded"`
 *                          `data-backlink-entry-id="..."` (when surface=backlink)
 *
 * Direction model:
 *
 *   `up`/`down` (h/k): walk block instances within the current panel in
 *     DOM order; on exhaustion, fall through to the panel that is the
 *     direct stack-sibling above/below in the same layout column.
 *   `left`/`right` (j/l): walk top-level layout columns; never moves
 *     within a panel.
 *
 * Recovery: two entry points share the same neighbor map.
 *   `locateInstance` (keystroke-time) keeps its tier 1+2 identity-match
 *   semantics, with a positional clamp as a last-resort tier.
 *   `findRecoveryAnchor` (proactive disappear-handler) is richer: it
 *   walks the stored sibling links first ("block previously below",
 *   else "block previously above"), then the ancestor chain (so a
 *   collapsed parent becomes the natural recovery target when every
 *   child of the focused block's parent unmounts together), then
 *   positional clamp as a final fallback. Both gate the positional
 *   tier on a blockId-match against the stored hint — a stale hint
 *   for some unrelated previous focus is ignored, so panels the user
 *   has never sat in won't get a misfired recovery jump.
 */

const INSTANCE_SELECTOR = '[data-block-instance]'
const PANEL_SELECTOR = '[data-panel-id]'
const COLUMN_SELECTOR = '[data-layout-column-id]'

const NON_NAVIGABLE_SURFACES = new Set(['breadcrumb'])

/**
 * Session-only per-panel hint about the focused block's neighborhood.
 * Stored on every confirmed sighting (`rememberInstancePosition`):
 *
 *   - `blockId` + `index` for the positional fallback + the
 *     stale-hint blockId-match guard
 *   - `prevBlockId` / `nextBlockId` for the sibling-walk recovery
 *     ("block previously below/above")
 *   - `ancestorBlockIds` (closest first) for the collapse-detection
 *     recovery — when both sibling links no longer resolve, the
 *     focused block's ancestors are the only nearby reference frame
 *     still standing, and the closest surviving one is the natural
 *     place to put focus
 *
 * Module-level, never persisted: the DOM order that gave any of
 * these meaning is gone after a reload, so persisting would mislead.
 */
interface PanelPositionHint {
  blockId: string
  index: number
  prevBlockId: string | undefined
  nextBlockId: string | undefined
  ancestorBlockIds: readonly string[]
}

const lastPositionByPanel = new Map<string, PanelPositionHint>()

const isNavigable = (el: HTMLElement): boolean => {
  const surface = el.dataset.blockSurface
  if (surface && NON_NAVIGABLE_SURFACES.has(surface)) return false
  return true
}

export const panelInstances = (panel: HTMLElement): HTMLElement[] => {
  const all = Array.from(panel.querySelectorAll<HTMLElement>(INSTANCE_SELECTOR))
  // Filter to instances actually inside this panel (not inside a nested
  // panel that might appear in the DOM tree — defensive; layout doesn't
  // currently nest panels, but the selector match alone wouldn't catch
  // it).
  return all.filter(el => {
    if (!isNavigable(el)) return false
    const ownPanel = el.closest<HTMLElement>(PANEL_SELECTOR)
    return ownPanel === panel
  })
}

export const panelOf = (el: HTMLElement): HTMLElement | null =>
  el.closest<HTMLElement>(PANEL_SELECTOR)

export const panelById = (
  panelId: string,
  root: ParentNode = document,
): HTMLElement | null => root.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`)

export const columnOf = (el: HTMLElement): HTMLElement | null =>
  el.closest<HTMLElement>(COLUMN_SELECTOR)

const orderedColumns = (root: ParentNode = document): HTMLElement[] =>
  Array.from(root.querySelectorAll<HTMLElement>(COLUMN_SELECTOR))

const panelsInColumn = (column: HTMLElement): HTMLElement[] =>
  Array.from(column.querySelectorAll<HTMLElement>(PANEL_SELECTOR))

const clamp = (n: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, n))

const collectAncestorBlockIds = (
  instanceEl: HTMLElement,
  panel: HTMLElement,
): string[] => {
  const ancestors: string[] = []
  let el: HTMLElement | null = instanceEl.parentElement
  while (el && el !== panel) {
    if (el.dataset.blockId && el.dataset.blockInstance) {
      ancestors.push(el.dataset.blockId)
    }
    el = el.parentElement
  }
  return ancestors
}

/**
 * Record the focused instance's neighborhood (siblings + ancestors +
 * positional index) inside its panel. Called whenever spatial
 * navigation (or the proactive focus-recovery watcher) confirms that
 * the focused block has a live DOM instance. The hint is consumed by
 * `findRecoveryAnchor` (and `locateInstance`'s positional tier) when
 * that block later disappears.
 */
export const rememberInstancePosition = (
  panelId: string,
  instanceEl: HTMLElement,
): void => {
  const panel = panelById(panelId)
  if (!panel) return
  const instances = panelInstances(panel)
  const idx = instances.indexOf(instanceEl)
  if (idx < 0) return
  const blockId = instanceEl.dataset.blockId
  if (!blockId) return
  lastPositionByPanel.set(panelId, {
    blockId,
    index: idx,
    prevBlockId: instances[idx - 1]?.dataset.blockId,
    nextBlockId: instances[idx + 1]?.dataset.blockId,
    ancestorBlockIds: collectAncestorBlockIds(instanceEl, panel),
  })
}

/**
 * Resolve a recovery target for `forBlockId` when its instance is no
 * longer in the panel DOM. Walks the stored neighbor map in this order:
 *
 *   1. The block that was immediately AFTER it ("block previously
 *      below") — the natural baseline when one entry is removed from
 *      a list and the remaining list shifts up: the user lands on
 *      what visually replaced their previous position.
 *   2. The block that was immediately BEFORE it. Engaged when the
 *      next sibling is also gone (focused block was last in the list,
 *      or the next sibling unmounted alongside).
 *   3. The closest ancestor that's still rendered. Handles collapse:
 *      when a parent collapses, every descendant unmounts together
 *      so neither sibling survives — but the parent itself does, and
 *      it's the natural place to land. Walks closest-first so the
 *      lowest surviving container wins.
 *   4. Positional clamp (last resort) — safety net for hints with
 *      no recoverable neighbors and no surviving ancestor.
 *
 * Returns null when there's no stored hint about this block, or when
 * the panel has no instances at all. The caller (proactive recovery)
 * MUST be gated on a non-null return: an absent hint usually means
 * the focused block has never been visible in this panel (initial
 * mount during async hydration) — quietly leaving the panel alone is
 * the right move there.
 */
export const findRecoveryAnchor = (
  panelId: string,
  forBlockId: string,
): HTMLElement | null => {
  const panel = panelById(panelId)
  if (!panel) return null
  const instances = panelInstances(panel)
  if (instances.length === 0) return null

  const hint = lastPositionByPanel.get(panelId)
  if (!hint || hint.blockId !== forBlockId) return null

  const findByBlockId = (id: string | undefined): HTMLElement | undefined =>
    id ? instances.find(el => el.dataset.blockId === id) : undefined

  const next = findByBlockId(hint.nextBlockId)
  if (next) return next

  const prev = findByBlockId(hint.prevBlockId)
  if (prev) return prev

  for (const ancestorId of hint.ancestorBlockIds) {
    const ancestor = findByBlockId(ancestorId)
    if (ancestor) return ancestor
  }

  return instances[clamp(hint.index, 0, instances.length - 1)] ?? null
}

/**
 * Resolve which instance inside `panelId` should hold focus, given the
 * persisted hints from the panel block. Falls back through tiers:
 *
 *   1. exact match on `focusedVisualTargetKey` (`data-block-instance`)
 *   2. any visible instance of `focusedBlockId` inside the panel
 *   3. positional clamp into the current list — pulls "the block that
 *      now occupies the index where the focused one used to sit", i.e.
 *      "block previously below" once the list shifts up to fill the
 *      gap. Only fires when the stored hint is actually about
 *      `focusedBlockId`; a stale hint for some unrelated previously-
 *      focused block is ignored.
 *   4. first instance in the panel (last-resort default).
 *
 * For the proactive disappear-handler, prefer `findRecoveryAnchor` —
 * it shares the same neighbor map but adds sibling- and ancestor-
 * aware recovery, which gives a much better answer when a collapse
 * unmounts a whole subtree at once.
 */
export const locateInstance = (
  panelId: string,
  hints: {
    focusedBlockId?: string
    focusedVisualTargetKey?: string
  },
  root: ParentNode = document,
): HTMLElement | null => {
  const panel = panelById(panelId, root)
  if (!panel) return null
  const instances = panelInstances(panel)
  if (instances.length === 0) return null

  if (hints.focusedVisualTargetKey) {
    const exact = instances.find(el => el.dataset.blockInstance === hints.focusedVisualTargetKey)
    if (exact) return exact
  }

  if (hints.focusedBlockId) {
    const byBlock = instances.find(el => el.dataset.blockId === hints.focusedBlockId)
    if (byBlock) return byBlock
  }

  const stored = lastPositionByPanel.get(panelId)
  if (stored && (!hints.focusedBlockId || stored.blockId === hints.focusedBlockId)) {
    return instances[clamp(stored.index, 0, instances.length - 1)] ?? null
  }

  return instances[0] ?? null
}

export const firstInstanceIn = (panel: HTMLElement): HTMLElement | null =>
  panelInstances(panel)[0] ?? null

export const lastInstanceIn = (panel: HTMLElement): HTMLElement | null => {
  const all = panelInstances(panel)
  return all.length > 0 ? all[all.length - 1] : null
}

/**
 * Within-panel + stack-sibling fall-through for h/k.
 *
 * 1. If there's a next/prev instance in the same panel in DOM order,
 *    return it.
 * 2. Else, if the panel sits inside a column that stacks multiple
 *    panels, fall through to the first/last instance of the
 *    immediately adjacent stack-sibling panel.
 * 3. Else, null (never crosses columns horizontally for h/k).
 */
export const verticalNeighbor = (
  current: HTMLElement,
  direction: 'up' | 'down',
): HTMLElement | null => {
  const panel = panelOf(current)
  if (!panel) return null
  const instances = panelInstances(panel)
  const idx = instances.indexOf(current)
  if (idx === -1) return null

  if (direction === 'down') {
    if (idx + 1 < instances.length) return instances[idx + 1]
  } else {
    if (idx - 1 >= 0) return instances[idx - 1]
  }

  // Exhausted in-panel — try stack-sibling.
  const sibling = stackSiblingPanel(panel, direction)
  if (!sibling) return null
  return direction === 'down' ? firstInstanceIn(sibling) : lastInstanceIn(sibling)
}

/**
 * Returns the panel one stack-step above/below `panel` in the *same*
 * layout column. Null when the column hosts only `panel` (single-panel
 * column) or `panel` sits at the column boundary.
 */
export const stackSiblingPanel = (
  panel: HTMLElement,
  direction: 'up' | 'down',
): HTMLElement | null => {
  const column = columnOf(panel)
  if (!column) return null
  const panels = panelsInColumn(column)
  if (panels.length <= 1) return null
  const idx = panels.indexOf(panel)
  if (idx === -1) return null
  const target = direction === 'down' ? idx + 1 : idx - 1
  return panels[target] ?? null
}

/**
 * Column-walker for j/l. Returns the *panel* to focus in the previous
 * or next layout column. For stacked columns it returns the column's
 * first panel; the caller can then apply sticky-return logic to pick
 * a different stack member (e.g. the last one the user focused in
 * that column).
 */
export const horizontalNeighborPanel = (
  current: HTMLElement,
  direction: 'left' | 'right',
  root: ParentNode = document,
): HTMLElement | null => {
  const column = columnOf(current)
  if (!column) return null
  const columns = orderedColumns(root)
  const idx = columns.indexOf(column)
  if (idx === -1) return null
  const target = direction === 'right' ? idx + 1 : idx - 1
  const nextColumn = columns[target]
  if (!nextColumn) return null
  return panelsInColumn(nextColumn)[0] ?? null
}

/** Test-only: drop the positional-index hints. */
export const __resetSpatialNavigationForTesting = (): void => {
  lastPositionByPanel.clear()
}
