import type { AppExtension } from '@/facets/facet.js'
import { blockShellDecoratorsFacet } from '@/extensions/blockInteraction.js'
import {
  panelMountsFacet,
  type PanelMountContribution,
} from '@/extensions/core.js'
import { systemToggle } from '@/facets/togglable.js'
import {
  spatialNavigationActionDecoratorsExtension,
  spatialNavigationActionsExtension,
} from './actions.ts'
import { PanelFocusRecovery } from './PanelFocusRecovery.tsx'
import { spatialNavigationShellDecorator } from './shell.ts'

const panelFocusRecoveryMount: PanelMountContribution = {
  id: 'spatial-navigation.panel-focus-recovery',
  component: PanelFocusRecovery,
}

export const spatialNavigationPlugin: AppExtension = systemToggle({
  id: 'system:spatial-navigation',
  name: 'Spatial navigation',
  description: 'Vim-style h/j/k/l block & panel navigation driven by visible DOM order.',
}).of([
  blockShellDecoratorsFacet.of(spatialNavigationShellDecorator, {source: 'spatial-navigation'}),
  // Shift-click selection in visible DOM order (across backlinks/embeds) is now
  // an ActionTransform on `extend_block_selection`, registered with the other
  // spatial navigation transforms below — matching the keyboard
  // `extend_selection_*` decorators.
  spatialNavigationActionDecoratorsExtension,
  spatialNavigationActionsExtension,
  // Per-panel watchdog: when the focused rendered location disappears
  // (backlink edited out, parent collapsed), recover to the nearest
  // rendered neighbor instead of leaving the panel with a dead focus pointer.
  panelMountsFacet.of(panelFocusRecoveryMount, {source: 'spatial-navigation'}),
])

export {
  getSpatialNavigationActionDecorators,
  getSpatialNavigationActions,
  spatialNavigationActionDecoratorsExtension,
  spatialNavigationActionsExtension,
} from './actions.ts'

export {
  __resetSpatialNavigationForTesting,
  findRecoveryAnchor,
  horizontalNeighborPanel,
  locateInstance,
  panelById,
  rememberInstancePosition,
  resolveCurrentAnchor,
  stackSiblingPanel,
  verticalNeighbor,
} from './walker.ts'

export default spatialNavigationPlugin
