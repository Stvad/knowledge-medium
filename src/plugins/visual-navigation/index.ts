import type { AppExtension } from '@/extensions/facet.ts'
import { blockShellDecoratorsFacet } from '@/extensions/blockInteraction.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import {
  visualNavigationActionDecoratorsExtension,
  visualNavigationActionsExtension,
} from './actions.ts'
import { visualNavigationShellDecorator } from './shell.ts'

export const visualNavigationPlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Visual navigation',
  description: 'Spatial keyboard navigation between blocks based on visible layout.',
}, [
  blockShellDecoratorsFacet.of(visualNavigationShellDecorator, {source: 'visual-navigation'}),
  visualNavigationActionDecoratorsExtension,
  visualNavigationActionsExtension,
])

export {
  getVisualNavigationActionDecorators,
  getVisualNavigationActions,
  visualNavigationActionDecoratorsExtension,
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
