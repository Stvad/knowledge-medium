import { createToggleStore } from '@/utils/toggleStore.js'

/** Open/closed state for the command palette. The mounted
 *  `CommandPalette` surface reads it via `useSyncExternalStore`; the
 *  actions and header button flip it. External callers reach it through
 *  `runActionById(COMMAND_PALETTE_ACTION_ID)`. */
export const commandPaletteToggle = createToggleStore('command-palette')
