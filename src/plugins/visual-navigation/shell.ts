import type { BlockShellDecoratorContribution } from '@/extensions/blockInteraction.ts'
import { VisualNavigationShellDecorator } from './VisualNavigationShellDecorator.tsx'

export const visualNavigationShellDecorator: BlockShellDecoratorContribution = () =>
  VisualNavigationShellDecorator
