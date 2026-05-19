import type { BlockShellDecoratorContribution } from '@/extensions/blockInteraction.ts'
import { BlockFocusShellDecorator } from '@/extensions/BlockFocusShellDecorator.tsx'

export const blockFocusShellDecorator: BlockShellDecoratorContribution = () =>
  BlockFocusShellDecorator
