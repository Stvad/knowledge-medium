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

const visualNavigationMoveDecorator = (
  actionId: 'move_down' | 'move_up',
  direction: Extract<VisualNavigationDirection, 'down' | 'up'>,
  description: string,
): ActionDecorator<typeof ActionContextTypes.NORMAL_MODE> => ({
  actionId,
  context: ActionContextTypes.NORMAL_MODE,
  decorate: action => ({
    ...action,
    description,
    handler: async (deps, trigger) => {
      if (await moveVisualFocusOrStay(deps, direction)) return
      await action.handler(deps, trigger)
    },
  }),
})

export function getVisualNavigationActionDecorators(): ActionDecorator<typeof ActionContextTypes.NORMAL_MODE>[] {
  return [
    visualNavigationMoveDecorator('move_down', 'down', 'Move focus visually down'),
    visualNavigationMoveDecorator('move_up', 'up', 'Move focus visually up'),
  ]
}

export const visualNavigationActionsExtension: AppExtension =
  getVisualNavigationActions().map(action =>
    actionsFacet.of(action as ActionConfig, {source: 'visual-navigation'}),
  )

export const visualNavigationActionDecoratorsExtension: AppExtension =
  getVisualNavigationActionDecorators().map(decorator =>
    actionDecoratorsFacet.of(decorator as ActionDecorator, {source: 'visual-navigation'}),
  )
