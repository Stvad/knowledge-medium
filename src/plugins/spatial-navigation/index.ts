import type { AppExtension } from '@/extensions/facet.js'
import { blockShellDecoratorsFacet } from '@/extensions/blockInteraction.js'
import {
  panelMountsFacet,
  type PanelMountContribution,
} from '@/extensions/core.js'
import { systemToggle } from '@/extensions/togglable.js'
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
  spatialNavigationActionDecoratorsExtension,
  spatialNavigationActionsExtension,
  // Per-panel watchdog: when the focused block disappears (backlink
  // edited out, parent collapsed) we focus "block just above" instead
  // of leaving the panel with a dead focusedBlockId pointer.
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
