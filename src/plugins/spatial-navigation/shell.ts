import type { BlockShellDecoratorContribution } from '@/extensions/blockInteraction.js'
import { SpatialNavigationShellDecorator } from './ShellDecorator.tsx'

export const spatialNavigationShellDecorator: BlockShellDecoratorContribution = () =>
  SpatialNavigationShellDecorator
