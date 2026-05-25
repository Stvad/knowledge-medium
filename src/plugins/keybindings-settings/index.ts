/**
 * User-facing keyboard-shortcut customisation. Stores per-action
 * overrides on a per-user prefs sub-block, contributes them to
 * `keybindingOverridesFacet` at first-paint via a localStorage cache,
 * and exposes a property editor that lists every action grouped by
 * context with edit / reset / disable affordances.
 *
 * Marked `essential: true` for the same reason as `extensions-settings`:
 * if disabled, no one would mirror the prefs block into the cache,
 * so changes wouldn't take effect across reloads. Plugins that don't
 * want users remapping their actions can still narrow contributions
 * via `actionsFacet`-level overrides — turning this plugin off would
 * just hide the settings UI, not the underlying mechanism.
 */
import type {AppExtension} from '@/extensions/facet.js'
import {systemToggle} from '@/extensions/togglable.js'
import {keybindingsSettingsDataExtension} from './dataExtension.ts'

export const keybindingsSettingsPlugin: AppExtension = systemToggle({
  id: 'system:keybindings-settings',
  name: 'Keyboard shortcuts',
  description: 'Lets you remap any action’s keyboard shortcut. Stores overrides on a per-user prefs block.',
  essential: true,
}).of([
  keybindingsSettingsDataExtension,
])

export {
  keybindingOverridesProp,
  keybindingsPrefsType,
  type StoredKeybindingOverride,
  type StoredKeybindingOverrides,
} from './config.ts'
