import { Block } from '@/data/block'
import type {
  ActionContextConfig,
  BaseShortcutDependencies,
} from '@/shortcuts/types.ts'

export const COMMAND_PALETTE_CONTEXT = 'command-palette'
export const COMMAND_PALETTE_ACTION_ID = 'command_palette'

export type CommandPaletteDependencies = BaseShortcutDependencies

const isCommandPaletteDependencies = (deps: unknown): deps is CommandPaletteDependencies =>
  typeof deps === 'object' &&
  deps !== null &&
  'uiStateBlock' in deps &&
  deps.uiStateBlock instanceof Block

export const commandPaletteActionContext: ActionContextConfig<typeof COMMAND_PALETTE_CONTEXT> = {
  type: COMMAND_PALETTE_CONTEXT,
  displayName: 'Command Palette',
  validateDependencies: isCommandPaletteDependencies,
}
