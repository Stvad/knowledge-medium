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
import {valuePresetPresentationsFacet} from '@/data/facets.js'
import {defineHiddenPresetPresentation} from '@/data/api'
import {extensionsDataExtension} from './dataExtension.ts'
import {extensionsOverridesPresetCore} from './config.ts'

export const extensionsSettingsPlugin: AppExtension = systemToggle({
  id: 'system:extensions-settings',
  name: 'Extensions (toggle storage)',
  description: 'Stores the overrides map and syncs each change into the localStorage cache so toggles take effect across reloads.',
  essential: true,
}).of([
  extensionsDataExtension,
  valuePresetPresentationsFacet.of(
    defineHiddenPresetPresentation(extensionsOverridesPresetCore, 'Extension overrides'),
    {source: 'extensions-settings'},
  ),
])

export {
  extensionsOverridesProp,
  extensionsPrefsType,
} from './config.ts'
