import { runActionById } from '@/shortcuts/runAction.js'

// Must match `openExtensionsSettingsAction.id`. Referenced by id rather
// than by importing the action so generic modules stay off the
// extensions-settings plugin's transitive import graph (navigation, prefs
// blocks); `runActionById` is a string-keyed registry by design.
const OPEN_EXTENSIONS_SETTINGS_ACTION_ID = 'open_extensions_settings'

/** Jump to Extensions settings from a core surface. `trigger` names the
 *  surface, as the event the action receives. Never throws: a failed jump is
 *  logged, not surfaced as an unhandled exception. */
export const openExtensionsSettings = (trigger: string): void => {
  try {
    void Promise.resolve(
      runActionById(OPEN_EXTENSIONS_SETTINGS_ACTION_ID, new CustomEvent(trigger)),
    ).catch((error) =>
      console.error(`Failed to open Extensions settings from ${trigger}`, error),
    )
  } catch (error) {
    // runActionById throws if <HotkeyReconciler/> isn't mounted.
    console.error(`Failed to open Extensions settings from ${trigger}`, error)
  }
}
