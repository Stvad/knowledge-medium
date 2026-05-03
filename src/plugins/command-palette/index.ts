import {
  actionsFacet,
  appMountsFacet,
  type AppMountContribution,
} from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.ts'
import { CommandPalette } from './CommandPalette.tsx'
import { toggleCommandPaletteEvent } from './events.ts'

export { CommandPalette } from './CommandPalette.tsx'
export { toggleCommandPaletteEvent } from './events.ts'

export const commandPaletteMount: AppMountContribution = {
  id: 'command-palette.dialog',
  component: CommandPalette,
}

export const commandPaletteAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: 'command_palette',
  description: 'Open command palette',
  context: ActionContextTypes.GLOBAL,
  handler: () => {
    window.dispatchEvent(new CustomEvent(toggleCommandPaletteEvent))
  },
  defaultBinding: {
    keys: ['cmd+k', 'ctrl+k'],
  },
  hideFromCommandPallet: true,
}

export const commandPalettePlugin: AppExtension = [
  appMountsFacet.of(commandPaletteMount, {source: 'command-palette'}),
  actionsFacet.of(commandPaletteAction, {source: 'command-palette'}),
]
