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
import { focusedBlockIdProp, isEditingProp } from '@/data/properties.ts'
import {
  quickActionItemsFacet,
  type QuickActionItem,
} from '@/plugins/swipe-quick-actions'
import { CommandPaletteHeaderItem } from './HeaderItem.tsx'
import { CommandPalette } from './CommandPalette.tsx'
import { toggleCommandPaletteEvent } from './events.ts'
import {
  COMMAND_PALETTE_ACTION_ID,
  COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
  commandPaletteActionContext,
} from './context.ts'

export { CommandPaletteHeaderItem } from './HeaderItem.tsx'
export { CommandPalette } from './CommandPalette.tsx'
export { toggleCommandPaletteEvent } from './events.ts'
export {
  COMMAND_PALETTE_ACTION_ID,
  COMMAND_PALETTE_CONTEXT,
  COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
  commandPaletteActionContext,
} from './context.ts'

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
 *  active and the palette lists block-context actions for it. We `await`
 *  the focus write before dispatching the toggle: the focus update goes
 *  through an async block mutation, and firing the event before it
 *  resolves leaves a window where the palette renders against the
 *  previously-focused block's NORMAL_MODE deps — selecting a command
 *  during that window would run it against the wrong block.
 *
 *  We also clear `isEditing` in the same tx. `useInEditMode(B)` is
 *  `focusedBlockId === B && isEditing`, so swiping B while another block
 *  was being edited would, after we point focus at B, make B count as
 *  in-edit-mode — and `vimNormalModeActivation` opts out of activating
 *  NORMAL_MODE when `context.inEditMode` is true, leaving the palette
 *  without block-context actions for B. */
export const commandPaletteForBlockAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: COMMAND_PALETTE_FOR_BLOCK_ACTION_ID,
  description: 'Open command palette',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Command,
  handler: async ({block, uiStateBlock}) => {
    await Promise.all([
      uiStateBlock.set(focusedBlockIdProp, block.id),
      uiStateBlock.set(isEditingProp, false),
    ])
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
