import type { AppExtension } from '@/extensions/facet.ts'
import { blockShellDecoratorsFacet } from '@/extensions/blockInteraction.ts'
import { systemToggle } from '@/extensions/togglable.ts'
import {
  spatialNavigationActionDecoratorsExtension,
  spatialNavigationActionsExtension,
} from './actions.ts'
import { spatialNavigationShellDecorator } from './shell.ts'

export const spatialNavigationPlugin: AppExtension = systemToggle({
  id: 'system:spatial-navigation',
  name: 'Spatial navigation',
  description: 'Vim-style h/j/k/l block & panel navigation driven by visible DOM order.',
}).of([
  blockShellDecoratorsFacet.of(spatialNavigationShellDecorator, {source: 'spatial-navigation'}),
  spatialNavigationActionDecoratorsExtension,
  spatialNavigationActionsExtension,
])

export {
  getSpatialNavigationActionDecorators,
  getSpatialNavigationActions,
  spatialNavigationActionDecoratorsExtension,
  spatialNavigationActionsExtension,
} from './actions.ts'

export {
  __resetSpatialNavigationForTesting,
  horizontalNeighborPanel,
  locateInstance,
  panelById,
  rememberInstancePosition,
  stackSiblingPanel,
  verticalNeighbor,
} from './walker.ts'
