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
 * Push focus onto `el`. DOM side-effects (focus, scroll, position
 * memory) run synchronously so the very next keystroke sees the
 * updated `document.activeElement`. The prop writes (focusedBlockId
 * / focusedVisualTargetKey on the destination panel block; optional
 * activePanelId on the layout session) batch into a single tx
 * fire-and-forget — atomic so subscribers see consistent state.
 *
 * Why batched: `useShortcutSurfaceActivations` gates `inFocus` on
 * both `useInFocus(block.id)` (reads the panel block's focusedBlockId)
 * AND `panelSurfaceActive` (reads the layout session's activePanelId).
 * If these update in separate txs there's a moment where the source
 * panel sees panelSurfaceActive=false while the destination's
 * focusedBlockId hasn't committed yet. Source deactivates normal-mode
 * before destination activates it → HotkeyReconciler tears down all
 * normal-mode bindings → the next keystroke fires with no binding.
 * Symptom: `l` works once but the next `k` does nothing.
 */
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

  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({block: 'nearest', inline: 'nearest'})
  }
  el.focus({preventScroll: true})

  const layoutEl = panel.closest<HTMLElement>('[data-layout-session-id]')
  const layoutSessionId = layoutEl?.dataset.layoutSessionId
  const layoutSession = layoutSessionId ? repo.block(layoutSessionId) : null
  const needsActivePanelUpdate = Boolean(
    layoutSession && layoutSession.peekProperty(activePanelIdProp) !== panelId,
  )

  void repo.tx(async tx => {
    await tx.setProperty(panelId, focusedBlockIdProp, blockId)
    await tx.setProperty(panelId, focusedVisualTargetKeyProp, instanceKey)
    await tx.setProperty(panelId, isEditingProp, false)
    if (needsActivePanelUpdate && layoutSession) {
      await tx.setProperty(layoutSession.id, activePanelIdProp, panelId)
    }
  }, {scope: ChangeScope.UiState, description: 'spatial-navigation focus'}).catch(error => {
    console.error('[spatial-navigation] focus tx failed', error)
  })
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
