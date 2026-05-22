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
 * Recovery: when the previously-focused instance is no longer mounted,
 *   `locateInstance` falls back through three tiers — exact key match,
 *   any instance of the same block in that panel, then a positional
 *   hint that resolves to "the block just above where the user was".
 *   The positional tier only fires when the stored hint actually
 *   describes the focused block we're recovering for — a stale hint
 *   for some unrelated previous focus is ignored, so panels the user
 *   has never sat in won't get a misfired recovery jump.
 */

const INSTANCE_SELECTOR = '[data-block-instance]'
const PANEL_SELECTOR = '[data-panel-id]'
const COLUMN_SELECTOR = '[data-layout-column-id]'

const NON_NAVIGABLE_SURFACES = new Set(['breadcrumb'])

/**
 * Session-only per-panel positional hint. Tracks `{blockId, index}` so
 * we can both find "block just above where the user was" AND verify
 * the hint is actually about the block we're recovering for — without
 * that match check a stale hint from earlier in the session could
 * snap focus into a panel the user has never visited. Module-level,
 * never persisted: the DOM order that gave the index meaning is gone
 * after a reload, so persisting would mislead.
 */
interface PanelPositionHint {
  blockId: string
  index: number
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

/**
 * Record the focused instance's `{blockId, index}` inside its panel.
 * Called whenever spatial navigation (or the proactive focus-recovery
 * watcher) confirms that the focused block has a live DOM instance.
 * The hint is consumed by `locateInstance`'s third-tier recovery when
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
  lastPositionByPanel.set(panelId, {blockId, index: idx})
}

/**
 * Read-only access to the stored positional hint. Proactive focus
 * recovery uses this to gate writes on a positive prior sighting —
 * `locateInstance`'s tier-4 fallback (first instance) is fine for
 * keystroke-time recovery but would forcibly steal focus on an
 * initial panel mount before async data finishes loading.
 */
export const peekPositionHint = (panelId: string): {blockId: string; index: number} | undefined =>
  lastPositionByPanel.get(panelId)

/**
 * Resolve which instance inside `panelId` should hold focus, given the
 * persisted hints from the panel block. Falls back through three tiers:
 *
 *   1. exact match on `focusedVisualTargetKey` (`data-block-instance`)
 *   2. any visible instance of `focusedBlockId` inside the panel
 *   3. "block just above where the user was" — the stored index minus
 *      one, clamped into the current list. Only fires when the stored
 *      hint is actually about `focusedBlockId`; a stale hint for some
 *      unrelated previously-focused block is ignored. The `-1` makes
 *      both user-visible cases land on the natural recovery target:
 *      a backlink edited out → the preceding sibling; the parent of
 *      the focused block collapsed → the parent itself (which, in
 *      DOM order, is the block immediately above the disappeared
 *      child).
 *   4. first instance in the panel (last-resort default).
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
    return instances[clamp(stored.index - 1, 0, instances.length - 1)] ?? null
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
