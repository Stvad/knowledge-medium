import {
  actionContextsFacet,
  actionsFacet,
  appMountsFacet,
  headerItemsFacet,
  type HeaderItemContribution,
  type AppMountContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { Command } from 'lucide-react'
import { setFocusedBlockId } from '@/data/properties.ts'
import {
  quickActionItemsFacet,
  type QuickActionItem,
} from '@/plugins/swipe-quick-actions'
import { CommandPaletteHeaderItem } from './HeaderItem.tsx'
import { CommandPalette } from './CommandPalette.tsx'
import { toggleCommandPaletteEvent } from './events.ts'
import { COMMAND_PALETTE_ACTION_ID, commandPaletteActionContext } from './context.ts'

export { CommandPaletteHeaderItem } from './HeaderItem.tsx'
export { CommandPalette } from './CommandPalette.tsx'
export { toggleCommandPaletteEvent } from './events.ts'
export {
  COMMAND_PALETTE_ACTION_ID,
  COMMAND_PALETTE_CONTEXT,
  commandPaletteActionContext,
} from './context.ts'

export const COMMAND_PALETTE_FOR_BLOCK_ACTION_ID = 'command_palette_for_block'

export const commandPaletteMount: AppMountContribution = {
  id: 'command-palette.dialog',
  component: CommandPalette,
}

export const commandPaletteAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: COMMAND_PALETTE_ACTION_ID,
  description: 'Open command palette',
  context: ActionContextTypes.GLOBAL,
  icon: Command,
  handler: () => {
    window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
  },
  defaultBinding: {
    keys: ['cmd+k', 'ctrl+k'],
  },
}

/** Quick-action variant that focuses the swiped block before opening the
 *  palette. The palette renders against the live `useActiveContextsState`,
 *  so making this block the focused one ensures NORMAL_MODE for it is
 *  active and the palette lists block-context actions for it. */
export const commandPaletteForBlockAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
  description: 'Open command palette',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Command,
  handler: ({block, uiStateBlock}) => {
    setFocusedBlockId(uiStateBlock, block.id)
    window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
  },
}

export const commandPaletteForBlockQuickAction: QuickActionItem = {
  actionId: COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
  label: 'Commands',
}

export const commandPaletteHeaderItem: HeaderItemContribution = {
  id: 'command-palette.header',
  region: 'end',
  component: CommandPaletteHeaderItem,
}

export const commandPalettePlugin: AppExtension = [
  appMountsFacet.of(commandPaletteMount, {source: 'command-palette'}),
  actionContextsFacet.of(commandPaletteActionContext, {source: 'command-palette'}),
  actionsFacet.of(commandPaletteAction, {source: 'command-palette'}),
  actionsFacet.of(commandPaletteForBlockAction, {source: 'command-palette'}),
  quickActionItemsFacet.of(commandPaletteForBlockQuickAction, {source: 'command-palette'}),
  headerItemsFacet.of(commandPaletteHeaderItem, {
    source: 'command-palette',
    precedence: 20,
  }),
]
