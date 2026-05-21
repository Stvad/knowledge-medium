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
  focusVisualTarget,
  focusedBlockIdProp,
  focusedVisualTargetKeyProp,
} from '@/data/properties'
import type { Block } from '@/data/block'
import {
  horizontalNeighborPanel,
  locateInstance,
  rememberInstancePosition,
  verticalNeighbor,
} from './walker.ts'

/**
 * Find the DOM instance currently driving navigation in the panel
 * holding `block`. Falls back through:
 *   1. `visualTargetId` from the shortcut surface (`data-block-instance`).
 *   2. `document.activeElement.closest('[data-block-instance]')`.
 *   3. `locateInstance(panelId, hints)` using the panel's stored focus
 *      props — the same 3-tier recovery walked by the post-navigation
 *      ensure-focus path.
 */
const currentInstance = (
  visualTargetId: string | undefined,
  uiStateBlock: Block,
): HTMLElement | null => {
  if (typeof document === 'undefined') return null

  if (visualTargetId) {
    const exact = document.querySelector<HTMLElement>(
      `[data-block-instance="${CSS.escape(visualTargetId)}"]`,
    )
    if (exact) return exact
  }

  const active = document.activeElement
  if (active instanceof HTMLElement) {
    const closest = active.closest<HTMLElement>('[data-block-instance]')
    if (closest) return closest
  }

  // uiStateBlock IS the panel block when we're inside a panel context,
  // so its id is the panel id.
  return locateInstance(uiStateBlock.id, {
    focusedBlockId: uiStateBlock.peekProperty(focusedBlockIdProp),
    focusedVisualTargetKey: uiStateBlock.peekProperty(focusedVisualTargetKeyProp),
  })
}

/**
 * Push focus onto `el`: write the panel block's focused props (so the
 * shell highlights), update the layout session's active panel if it
 * changed, record the positional-index hint, scroll into view, and
 * give the DOM focus to the element so the shortcut-surface picks it
 * up on the next keystroke.
 */
const focusInstance = async (
  el: HTMLElement,
  repo: Block['repo'],
): Promise<void> => {
  const panel = el.closest<HTMLElement>('[data-panel-id]')
  if (!panel) return
  const panelId = panel.dataset.panelId
  if (!panelId) return
  const blockId = el.dataset.blockId
  const instanceKey = el.dataset.blockInstance
  if (!blockId || !instanceKey) return

  rememberInstancePosition(panelId, el)

  const panelBlock = repo.block(panelId)
  await focusVisualTarget(panelBlock, blockId, instanceKey)

  const layoutEl = panel.closest<HTMLElement>('[data-layout-session-id]')
  const layoutSessionId = layoutEl?.dataset.layoutSessionId
  if (layoutSessionId) {
    const layoutSession = repo.block(layoutSessionId)
    if (layoutSession.peekProperty(activePanelIdProp) !== panelId) {
      await layoutSession.set(activePanelIdProp, panelId)
    }
  }

  if (typeof el.scrollIntoView === 'function') {
    el.scrollIntoView({block: 'nearest', inline: 'nearest'})
  }
  el.focus({preventScroll: true})
}

/**
 * Try to move vertically in the registered DOM. Returns true on a
 * successful navigation; false signals "no spatial move available" so
 * the decorated `move_down` / `move_up` action can fall through to its
 * data-walker implementation (defensive — under normal mount every
 * visible block is tagged).
 */
const moveVertical = async (
  deps: BlockShortcutDependencies,
  direction: 'up' | 'down',
): Promise<boolean> => {
  const {block, uiStateBlock, visualTargetId} = deps
  if (!block || !uiStateBlock) return false
  const current = currentInstance(visualTargetId, uiStateBlock)
  if (!current) return false
  const next = verticalNeighbor(current, direction)
  if (!next) return false
  await focusInstance(next, block.repo)
  return true
}

/**
 * Cross-column move. On entering a destination panel, restores the
 * panel's last-known focused instance (sticky return) via the panel
 * block's `focusedBlockId` + `focusedVisualTargetKey` — these were
 * written every time spatial nav settled in that panel, so they
 * survive across the user's column hops.
 */
const moveHorizontal = async (
  deps: BlockShortcutDependencies,
  direction: 'left' | 'right',
): Promise<boolean> => {
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
  if (!dest) {
    // Empty destination panel (rare — e.g. a panel mid-mount). Fall
    // back to setting just `activePanelIdProp` so subsequent keystrokes
    // see the layout settled on the new panel.
    const layoutEl = destPanel.closest<HTMLElement>('[data-layout-session-id]')
    const layoutSessionId = layoutEl?.dataset.layoutSessionId
    if (layoutSessionId) {
      const layoutSession = block.repo.block(layoutSessionId)
      if (layoutSession.peekProperty(activePanelIdProp) !== destPanelId) {
        await layoutSession.set(activePanelIdProp, destPanelId)
      }
    }
    return true
  }
  await focusInstance(dest, block.repo)
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
        await moveHorizontal(deps, 'left')
      },
      defaultBinding: {keys: ['left', 'j']},
    }),
    bindNormal({
      id: 'move_right',
      description: 'Move focus to the panel on the right',
      handler: async (deps: BlockShortcutDependencies) => {
        await moveHorizontal(deps, 'right')
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
      if (await moveVertical(deps, direction)) return
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
