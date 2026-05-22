import type { BlockShellDecoratorContribution } from '@/extensions/blockInteraction.js'
import { VisualNavigationShellDecorator } from './VisualNavigationShellDecorator.tsx'

export const visualNavigationShellDecorator: BlockShellDecoratorContribution = () =>
  VisualNavigationShellDecorator
