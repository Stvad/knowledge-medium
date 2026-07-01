/**
 * Extensions meta-plugin — owns the runtime-toggle overrides
 * map: schema, sub-block, and the subscription effect that keeps
 * the localStorage first-paint cache in sync with PowerSync.
 *
 * The plugin itself must be `essential: true`:
 * if disabled, no one would be writing the cache or dispatching
 * refresh, so toggle changes wouldn't take effect.
 */

import type {AppExtension} from '@/facets/facet.js'
import {systemToggle} from '@/facets/togglable.js'
import {actionsFacet} from '@/extensions/core.js'
import {propertyEditorOverridesFacet} from '@/data/facets.js'
import {extensionsDataExtension} from './dataExtension.ts'
import {extensionsOverridesUi} from './propertyEditorOverride.ts'
import {openExtensionsSettingsAction} from './actions.ts'

export const extensionsSettingsPlugin: AppExtension = systemToggle({
  id: 'system:extensions-settings',
  name: 'Extensions (toggle storage)',
  description: 'Stores the overrides map and syncs each change into the localStorage cache so toggles take effect across reloads.',
  essential: true,
}).of([
  extensionsDataExtension,
  // UI + the "Manage extensions" action live here, not in dataExtension:
  // the editor imports useToggleTree → staticAppExtensions, and the action's
  // handler imports `navigate` → React. Keeping them out keeps dataExtension
  // graph-free for the pluginDataExtensions glob.
  propertyEditorOverridesFacet.of(extensionsOverridesUi, {source: 'extensions-settings'}),
  actionsFacet.of(openExtensionsSettingsAction, {source: 'extensions-settings'}),
])

export {
  extensionsOverridesProp,
  extensionsPrefsType,
} from './config.ts'

export default extensionsSettingsPlugin

export const pluginOrder = -10
