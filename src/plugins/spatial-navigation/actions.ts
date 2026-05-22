import {
  actionDecoratorsFacet,
  actionsFacet,
} from '@/extensions/core.js'
import type { AppExtension } from '@/extensions/facet.js'
import {
  ActionConfig,
  type ActionDecorator,
  ActionContextTypes,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import type { BlockAction } from '@/shortcuts/blockActions.js'
import { bindBlockActionContext } from '@/shortcuts/blockActions.js'
import {
  activePanelIdProp,
  focusBlock,
  focusedBlockIdProp,
  isEditingProp,
} from '@/data/properties'
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import {
  horizontalNeighborPanel,
  verticalNeighbor,
} from './walker.ts'

/**
 * Locate the DOM instance for `(panelId, blockId)`. With the focused
 * block tracked on the panel block via `focusedBlockIdProp` — the same
 * primitive vim normal-mode uses — we drive everything from that prop
 * + a DOM lookup. No `document.activeElement` reads, no in-memory
 * shadow state. If the same block appears more than once in the panel
 * (e.g. duplicate backlink references), we pick the first DOM
 * occurrence; the second is unreachable via spatial nav until the
 * surfacing plugin gives them distinct identities.
 */
const findInstance = (
  panelId: string,
  blockId: string,
): HTMLElement | null => {
  if (typeof document === 'undefined') return null
  const panel = document.querySelector<HTMLElement>(`[data-panel-id="${CSS.escape(panelId)}"]`)
  if (!panel) return null
  return panel.querySelector<HTMLElement>(`[data-block-id="${CSS.escape(blockId)}"][data-block-instance]`)
}

const currentInstance = (
  deps: BlockShortcutDependencies,
): HTMLElement | null => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return null
  return findInstance(uiStateBlock.id, block.id)
}

/**
 * Move spatial focus within a panel. Mirrors vim's `move_down` /
 * `move_up` behavior exactly: write the new focused block id to the
 * panel block via `focusBlock`. No DOM-focus call, no scroll — the
 * kernel `BlockFocusShellDecorator` already drives both
 * (highlight class via `useInFocus`, scroll via its own effect)
 * off the same prop. Adding our own DOM mutations would just race.
 *
 * Return contract (intentionally different from "did we move?"):
 *   - `false` → "no anchor; please fall through to the underlying
 *     vim handler". Only the `!current` early return takes this
 *     path — the spatial walker had no DOM anchor to start from
 *     so vim's data-model walk is a legitimate fallback.
 *   - `true` → "spatial nav handled this keystroke". Includes the
 *     no-neighbor / panel-boundary case. We must NOT fall through
 *     to vim's `nextVisibleBlock` for a panel-boundary block on a
 *     non-outline surface (backlinks, embeds): vim's walker climbs
 *     the data-model parent chain of the source block, which for a
 *     backlink entry lives in some other page entirely. Following
 *     that chain returns a block from elsewhere in the workspace,
 *     and writing it as the panel's `focusedBlockId` leaves
 *     `useInFocus(<anyone in this panel>)` returning false →
 *     normal-mode deactivates → all shortcuts go dead until the
 *     user clicks back into a block.
 */
const moveVertical = async (
  deps: BlockShortcutDependencies,
  direction: 'up' | 'down',
): Promise<boolean> => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return false
  const current = currentInstance(deps)
  if (!current) return false
  const next = verticalNeighbor(current, direction)
  if (!next) return true // boundary — handled, no move
  const destPanel = next.closest<HTMLElement>('[data-panel-id]')
  if (!destPanel) return true
  const destPanelId = destPanel.dataset.panelId
  const destBlockId = next.dataset.blockId
  if (!destPanelId || !destBlockId) return true

  if (destPanelId === uiStateBlock.id) {
    // Same-panel step — identical to vim's `focusBlock` write.
    void focusBlock(uiStateBlock, destBlockId)
    return true
  }

  // Crossed into a stack-sibling panel below/above. Activate the new
  // panel atomically with the focus write so `useShortcutSurfaceActivations`
  // doesn't see a window where source panel is inactive AND
  // destination's focused block hasn't moved yet.
  await crossPanelFocus(uiStateBlock, destPanelId, destBlockId)
  return true
}

const moveHorizontal = async (
  deps: BlockShortcutDependencies,
  direction: 'left' | 'right',
): Promise<boolean> => {
  const {block, uiStateBlock} = deps
  if (!block || !uiStateBlock) return false
  const current = currentInstance(deps)
  if (!current) return false
  const destPanel = horizontalNeighborPanel(current, direction)
  if (!destPanel) return false
  const destPanelId = destPanel.dataset.panelId
  if (!destPanelId) return false
  const destPanelBlock = uiStateBlock.repo.block(destPanelId)
  // Sticky-return: read the panel's stored focus, fall back to its
  // top-level (the panel's `topLevelBlockIdProp` aligned to its
  // outline root).
  const destBlockId = destPanelBlock.peekProperty(focusedBlockIdProp)
    ?? findFirstInstanceBlockId(destPanel)
  if (!destBlockId) return false
  await crossPanelFocus(uiStateBlock, destPanelId, destBlockId)
  return true
}

const findFirstInstanceBlockId = (panel: HTMLElement): string | undefined => {
  const first = panel.querySelector<HTMLElement>('[data-block-instance]')
  return first?.dataset.blockId
}

const crossPanelFocus = async (
  sourcePanelBlock: Block,
  destPanelId: string,
  destBlockId: string,
): Promise<void> => {
  const repo = sourcePanelBlock.repo
  const destPanelBlock = repo.block(destPanelId)
  // Find the layout session by walking up the DOM — its id is on the
  // outer layout div. Cheap; runs once per cross-panel keystroke.
  const layoutEl = typeof document !== 'undefined'
    ? document.querySelector<HTMLElement>('[data-layout-session-id]')
    : null
  const layoutSessionId = layoutEl?.dataset.layoutSessionId
  // Single tx that flips both ends of the activation gate at once.
  // Same shape as `focusBlock` but adds the activePanelId write on
  // the layout-session block; row deps still resolve identically
  // (same kind:'row' invalidation per touched block).
  await repo.tx(async tx => {
    if (layoutSessionId) {
      await tx.setProperty(layoutSessionId, activePanelIdProp, destPanelId)
    }
    await tx.setProperty(destPanelBlock.id, focusedBlockIdProp, destBlockId)
    if (destPanelBlock.peekProperty(isEditingProp) === true) {
      await tx.setProperty(destPanelBlock.id, isEditingProp, false)
    }
  }, {scope: ChangeScope.UiState, description: 'spatial-navigation cross-panel focus'})
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
