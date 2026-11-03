import { runActionByIdSafely } from '@/shortcuts/runAction.js'

/** The id the extensions-settings plugin registers its "Manage extensions"
 *  action under. Declared here so core surfaces can open settings by id
 *  without importing the plugin. */
export const OPEN_EXTENSIONS_SETTINGS_ACTION_ID = 'open_extensions_settings'

/** Jump to Extensions settings from a core surface. `trigger` names the
 *  surface, as the event the action receives. Never throws. */
export const openExtensionsSettings = (trigger: string): void => {
  void runActionByIdSafely(OPEN_EXTENSIONS_SETTINGS_ACTION_ID, new CustomEvent(trigger))
}
