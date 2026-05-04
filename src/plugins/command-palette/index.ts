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

export const commandPaletteMount: AppMountContribution = {
  id: 'command-palette.dialog',
  component: CommandPalette,
}

export const commandPaletteAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: COMMAND_PALETTE_ACTION_ID,
  description: 'Open command palette',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
  },
  defaultBinding: {
    keys: ['cmd+k', 'ctrl+k'],
  },
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
  headerItemsFacet.of(commandPaletteHeaderItem, {
    source: 'command-palette',
    precedence: 20,
  }),
]
