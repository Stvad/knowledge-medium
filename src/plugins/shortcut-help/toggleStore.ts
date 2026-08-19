import { createToggleStore } from '@/utils/toggleStore.js'

/** Open/closed state for the shortcut-help overlay. The mounted
 *  `ShortcutHelpOverlay` reads it via `useSyncExternalStore`; the global
 *  `shortcut_help` action flips it. External callers reach it through
 *  `runActionById(SHORTCUT_HELP_ACTION_ID)`, never by importing this store. */
export const shortcutHelpToggle = createToggleStore('shortcut-help')
