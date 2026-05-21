import {
  actionDecoratorsFacet,
  actionsFacet,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  ActionConfig,
  type ActionDecorator,
  ActionContextTypes,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import type { BlockAction } from '@/shortcuts/blockActions.ts'
import { bindBlockActionContext } from '@/shortcuts/blockActions.ts'
import {
  activePanelIdProp,
  focusedBlockIdProp,
  focusedVisualTargetKeyProp,
  isEditingProp,
} from '@/data/properties'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import {
  horizontalNeighborPanel,
  locateInstance,
  rememberInstancePosition,
  verticalNeighbor,
} from './walker.ts'
import { setSpatialFocusedInstance } from './focusStore.ts'

/**
 * Find the DOM instance currently driving navigation. Order of
 * preference:
 *
 *   1. `document.activeElement.closest('[data-block-instance]')` —
 *      the freshest possible source. Our own focusInstance() calls
 *      el.focus() synchronously, so this updates BEFORE the React
 *      shortcut surface re-binds. Using `visualTargetId` from deps
 *      first would read a stale value during held-down keys and
 *      walk repeatedly from the previous block.
 *   2. `visualTargetId` from the shortcut surface — the React-bound
 *      target id. Used when the user just arrived via something
 *      other than focus (e.g. tab from outside, click).
 *   3. `locateInstance(panelId, hints)` — full 3-tier recovery
 *      from the panel's stored focus props.
 */
const currentInstance = (
  visualTargetId: string | undefined,
  uiStateBlock: Block,
): HTMLElement | null => {
  if (typeof document === 'undefined') return null

  const active = document.activeElement
  if (active instanceof HTMLElement) {
    const closest = active.closest<HTMLElement>('[data-block-instance]')
    if (closest) return closest
  }

  if (visualTargetId) {
    const exact = document.querySelector<HTMLElement>(
      `[data-block-instance="${CSS.escape(visualTargetId)}"]`,
    )
    if (exact) return exact
  }

  // uiStateBlock IS the panel block when we're inside a panel context,
  // so its id is the panel id.
  return locateInstance(uiStateBlock.id, {
    focusedBlockId: uiStateBlock.peekProperty(focusedBlockIdProp),
    focusedVisualTargetKey: uiStateBlock.peekProperty(focusedVisualTargetKeyProp),
  })
}

/**
 * Why this is debounced for same-panel nav:
 *
 * Writing `focusedBlockId` / `focusedVisualTargetKey` on the panel
 * block invalidates every query that has it in scope — in practice
 * the layout session's `core.subtree` query, which on large graphs
 * runs ~500–800ms per invalidation. Held-down nav fires the handler
 * dozens of times per second; per-step writes pile up multi-second
 * tx queues and produce the "1 second per click" feel.
 *
 * The persisted props matter for:
 *   1. `useInFocus(block.id)` driving normal-mode action-context
 *      activation through `useShortcutSurfaceActivations`.
 *   2. Reload recovery (so focus restores to where the user last was).
 *
 * For (1) we don't need to update the prop on every step. Whatever
 * block was in-focus at the start of the burst keeps normal-mode
 * activated — the binding is global. The handler uses
 * `document.activeElement` to find the current target, not the prop.
 * For (2) the FINAL destination is what we care about; intermediate
 * positions during a burst are wasted state.
 *
 * So same-panel nav: schedule a debounced write of the final state.
 * Cross-panel nav: must write immediately AND atomically with
 * `activePanelId`, because `panelSurfaceActive` (which reads
 * activePanelId) gates `inFocus` — if those two updates land in
 * separate commits, source-panel `inFocus` flips false before
 * destination's flips true, deactivating normal-mode and tearing
 * down all bindings for the gap. Symptom of the broken sequence:
 * `l` works once, the next `k` does nothing.
 */
const PERSIST_FOCUS_DEBOUNCE_MS = 200

interface PendingPersist {
  panelId: string
  blockId: string
  instanceKey: string
  repo: Block['repo']
  timer: ReturnType<typeof setTimeout>
}

let pendingPersist: PendingPersist | null = null

const persistedAlready = (panelId: string, blockId: string, instanceKey: string, repo: Block['repo']): boolean => {
  const panelBlock = repo.block(panelId)
  return panelBlock.peekProperty(focusedBlockIdProp) === blockId
    && panelBlock.peekProperty(focusedVisualTargetKeyProp) === instanceKey
}

const flushPendingPersist = (pending: PendingPersist): void => {
  const {panelId, blockId, instanceKey, repo} = pending
  if (persistedAlready(panelId, blockId, instanceKey, repo)) return
  const panelBlock = repo.block(panelId)
  const wasEditing = panelBlock.peekProperty(isEditingProp) === true
  void repo.tx(async tx => {
    await tx.setProperty(panelId, focusedBlockIdProp, blockId)
    await tx.setProperty(panelId, focusedVisualTargetKeyProp, instanceKey)
    if (wasEditing) await tx.setProperty(panelId, isEditingProp, false)
  }, {scope: ChangeScope.UiState, description: 'spatial-navigation focus (settle)'}).catch(error => {
    console.error('[spatial-navigation] settle write failed', error)
  })
}

const schedulePersistFocus = (
  panelId: string,
  blockId: string,
  instanceKey: string,
  repo: Block['repo'],
): void => {
  if (pendingPersist) clearTimeout(pendingPersist.timer)
  const timer = setTimeout(() => {
    const pending = pendingPersist
    pendingPersist = null
    if (pending) flushPendingPersist(pending)
  }, PERSIST_FOCUS_DEBOUNCE_MS)
  pendingPersist = {panelId, blockId, instanceKey, repo, timer}
}

const focusInstance = (
  el: HTMLElement,
  repo: Block['repo'],
): void => {
  const panel = el.closest<HTMLElement>('[data-panel-id]')
  if (!panel) return
  const panelId = panel.dataset.panelId
  if (!panelId) return
  const blockId = el.dataset.blockId
  const instanceKey = el.dataset.blockInstance
  if (!blockId || !instanceKey) return

  rememberInstancePosition(panelId, el)

  // Synchronously update the in-memory focused-instance store so the
  // shell decorator can re-render the highlight on this keystroke
  // without waiting for the debounced prop write to commit. Without
  // this the only focus indicator (BlockFocusShellDecorator's bg
  // class, driven by `useInFocus` reading the persisted prop) lags
  // 200ms behind a held-down nav key, and the plugin feels frozen.
  setSpatialFocusedInstance(instanceKey)

  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({block: 'nearest', inline: 'nearest'})
  }
  el.focus({preventScroll: true})

  const layoutEl = panel.closest<HTMLElement>('[data-layout-session-id]')
  const layoutSessionId = layoutEl?.dataset.layoutSessionId
  const layoutSession = layoutSessionId ? repo.block(layoutSessionId) : null
  const isPanelHop = Boolean(
    layoutSession && layoutSession.peekProperty(activePanelIdProp) !== panelId,
  )

  if (isPanelHop && layoutSession) {
    // Cancel any pending same-panel debounce — the panel just changed
    // and the queued state would write to a stale panel id.
    if (pendingPersist) {
      clearTimeout(pendingPersist.timer)
      pendingPersist = null
    }
    const wasEditing = repo.block(panelId).peekProperty(isEditingProp) === true
    void repo.tx(async tx => {
      await tx.setProperty(panelId, focusedBlockIdProp, blockId)
      await tx.setProperty(panelId, focusedVisualTargetKeyProp, instanceKey)
      if (wasEditing) await tx.setProperty(panelId, isEditingProp, false)
      await tx.setProperty(layoutSession.id, activePanelIdProp, panelId)
    }, {scope: ChangeScope.UiState, description: 'spatial-navigation focus (panel hop)'}).catch(error => {
      console.error('[spatial-navigation] panel-hop tx failed', error)
    })
    return
  }

  // Same-panel nav: debounce. The current panel keeps `useInFocus(prev)
  // === true` for the original focus target until the debounce fires,
  // which is enough to keep normal-mode bound and the handler firing.
  schedulePersistFocus(panelId, blockId, instanceKey, repo)
}

/**
 * Try to move vertically in the registered DOM. Returns true on a
 * successful navigation; false signals "no spatial move available" so
 * the decorated `move_down` / `move_up` action can fall through to its
 * data-walker implementation (defensive — under normal mount every
 * visible block is tagged).
 */
const moveVertical = (
  deps: BlockShortcutDependencies,
  direction: 'up' | 'down',
): boolean => {
  const {block, uiStateBlock, visualTargetId} = deps
  if (!block || !uiStateBlock) return false
  const current = currentInstance(visualTargetId, uiStateBlock)
  if (!current) return false
  const next = verticalNeighbor(current, direction)
  if (!next) return false
  focusInstance(next, block.repo)
  return true
}

/**
 * Cross-column move. On entering a destination panel, restores the
 * panel's last-known focused instance (sticky return) via the panel
 * block's `focusedBlockId` + `focusedVisualTargetKey` — these were
 * written every time spatial nav settled in that panel, so they
 * survive across the user's column hops.
 */
const moveHorizontal = (
  deps: BlockShortcutDependencies,
  direction: 'left' | 'right',
): boolean => {
  const {block, uiStateBlock, visualTargetId} = deps
  if (!block || !uiStateBlock) return false
  const current = currentInstance(visualTargetId, uiStateBlock)
  if (!current) return false
  const destPanel = horizontalNeighborPanel(current, direction)
  if (!destPanel) return false
  const destPanelId = destPanel.dataset.panelId
  if (!destPanelId) return false
  const destPanelBlock = block.repo.block(destPanelId)
  const dest = locateInstance(destPanelId, {
    focusedBlockId: destPanelBlock.peekProperty(focusedBlockIdProp),
    focusedVisualTargetKey: destPanelBlock.peekProperty(focusedVisualTargetKeyProp),
  })
  if (!dest) return false
  focusInstance(dest, block.repo)
  return true
}

export function getSpatialNavigationActions(): ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] {
  const bindNormal = (action: BlockAction) =>
    bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action)

  return [
    bindNormal({
      id: 'move_left',
      description: 'Move focus to the panel on the left',
      handler: async (deps: BlockShortcutDependencies) => {
        moveHorizontal(deps, 'left')
      },
      defaultBinding: {keys: ['left', 'j']},
    }),
    bindNormal({
      id: 'move_right',
      description: 'Move focus to the panel on the right',
      handler: async (deps: BlockShortcutDependencies) => {
        moveHorizontal(deps, 'right')
      },
      defaultBinding: {keys: ['right', 'l']},
    }),
  ]
}

const verticalDecorator = (
  actionId: 'move_down' | 'move_up',
  direction: 'down' | 'up',
  description: string,
): ActionDecorator<typeof ActionContextTypes.NORMAL_MODE> => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  decorate: action => ({
    ...action,
    description,
    handler: async (deps, trigger) => {
      if (moveVertical(deps, direction)) return
      // Defensive fallback: nothing in the DOM matched. Let the
      // underlying vim-normal-mode handler do its data-model walk.
      await action.handler(deps, trigger)
    },
  }),
})

export function getSpatialNavigationActionDecorators(): ActionDecorator<typeof ActionContextTypes.NORMAL_MODE>[] {
  return [
    verticalDecorator('move_down', 'down', 'Move focus down (next block, then stack-sibling panel below)'),
    verticalDecorator('move_up', 'up', 'Move focus up (previous block, then stack-sibling panel above)'),
  ]
}

export const spatialNavigationActionsExtension: AppExtension =
  getSpatialNavigationActions().map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'spatial-navigation'}),
  )

export const spatialNavigationActionDecoratorsExtension: AppExtension =
  getSpatialNavigationActionDecorators().map(decorator =>
    actionDecoratorsFacet.of(decorator as ActionDecorator, {source: 'spatial-navigation'}),
  )
