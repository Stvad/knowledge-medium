import type { BlockShellDecoratorContribution } from '@/extensions/blockInteraction.ts'
import { SpatialNavigationShellDecorator } from './ShellDecorator.tsx'

export const spatialNavigationShellDecorator: BlockShellDecoratorContribution = () =>
  SpatialNavigationShellDecorator
