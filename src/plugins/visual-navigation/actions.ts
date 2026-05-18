import {
  focusBlock,
  topLevelBlockIdProp,
} from '@/data/properties.ts'
import {
  nextVisibleBlock,
  previousVisibleBlock,
} from '@/utils/selection.ts'
import { actionsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import {
  ActionConfig,
  ActionContextTypes,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import type { BlockAction } from '@/shortcuts/blockActions.ts'
import { bindBlockActionContext } from '@/shortcuts/blockActions.ts'
import {
  moveVisualFocus,
  type VisualNavigationDirection,
} from './navigation.ts'

const moveVisualFocusOrStay = async (
  deps: BlockShortcutDependencies,
  direction: VisualNavigationDirection,
): Promise<boolean> => {
  const {block, uiStateBlock, visualTargetId} = deps
  if (!block || !uiStateBlock) return false
  if (await moveVisualFocus({block, uiStateBlock, visualTargetId}, direction)) return true
  return Boolean(visualTargetId)
}

export function getVisualNavigationActions(): ActionConfig<typeof ActionContextTypes.NORMAL_MODE>[] {
  const bindNormal = (action: BlockAction) => bindBlockActionContext(ActionContextTypes.NORMAL_MODE, action)

  return [
    bindNormal({
      id: 'move_down',
      description: 'Move focus visually down',
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        if (await moveVisualFocusOrStay(deps, 'down')) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId) return

        const next = await nextVisibleBlock(block, topLevelBlockId)
        if (next) void focusBlock(uiStateBlock, next.id)
      },
      defaultBinding: {
        keys: ['down', 'k'],
      },
    }),
    bindNormal({
      id: 'move_up',
      description: 'Move focus visually up',
      handler: async (deps: BlockShortcutDependencies) => {
        const {block, uiStateBlock} = deps
        if (!block || !uiStateBlock) return

        if (await moveVisualFocusOrStay(deps, 'up')) return

        const topLevelBlockId = uiStateBlock.peekProperty(topLevelBlockIdProp)
        if (!topLevelBlockId) return

        const prev = await previousVisibleBlock(block, topLevelBlockId)
        if (prev) void focusBlock(uiStateBlock, prev.id)
      },
      defaultBinding: {
        keys: ['up', 'h'],
      },
    }),
    bindNormal({
      id: 'move_left',
      description: 'Move focus visually left',
      handler: async (deps: BlockShortcutDependencies) => {
        await moveVisualFocusOrStay(deps, 'left')
      },
      defaultBinding: {
        keys: ['left', 'j'],
      },
    }),
    bindNormal({
      id: 'move_right',
      description: 'Move focus visually right',
      handler: async (deps: BlockShortcutDependencies) => {
        await moveVisualFocusOrStay(deps, 'right')
      },
      defaultBinding: {
        keys: ['right', 'l'],
      },
    }),
  ]
}

export const visualNavigationActionsExtension: AppExtension =
  getVisualNavigationActions().map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'visual-navigation'}),
  )
