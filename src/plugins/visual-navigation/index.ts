import type { AppExtension } from '@/extensions/facet.ts'
import { blockShellDecoratorsFacet } from '@/extensions/blockInteraction.ts'
import { visualNavigationActionsExtension } from './actions.ts'
import { visualNavigationShellDecorator } from './shell.ts'

export const visualNavigationPlugin: AppExtension = [
  blockShellDecoratorsFacet.of(visualNavigationShellDecorator, {source: 'visual-navigation'}),
  visualNavigationActionsExtension,
]

export {
  getVisualNavigationActions,
  visualNavigationActionsExtension,
} from './actions.ts'

export {
  visualNavigationShellDecorator,
} from './shell.ts'

export {
  __resetVisualNavigationForTesting,
  getActiveVisualNavigationTarget,
  moveVisualFocus,
  pickVisualNavigationTarget,
  registerVisualNavigationTarget,
  setActiveVisualNavigationTarget,
  useVisualNavigationTarget,
  visualNavigationSurfaceFromContext,
} from './navigation.ts'

export type {
  RegisteredVisualNavigationTarget,
  RegisterVisualNavigationTargetInput,
  VisualNavigationCandidate,
  VisualNavigationDirection,
  VisualNavigationMoveInput,
  VisualNavigationRect,
  VisualNavigationSurface,
} from './navigation.ts'
