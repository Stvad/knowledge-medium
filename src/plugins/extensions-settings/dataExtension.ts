/**
 * Extensions meta-plugin data registrations — DATA ONLY, so this module
 * stays graph-free for the `pluginDataExtensions` glob (the headless
 * local-schema / data path). The UI editor and the "Manage extensions"
 * command-palette action (its handler imports `navigate` → React) live in
 * `./index.ts` instead.
 *
 *   - `propertySchemasFacet` registers the overrides codec so the
 *     property reads/writes go through the strict decoder.
 *   - `pluginPrefsExtension` bundles the `typesFacet` registration
 *     for the prefs sub-block with an idle-time eager bootstrap.
 *     The bootstrap creates the block before the user navigates to
 *     Preferences, so its existence isn't gated on opening the
 *     settings UI.
 *   - `extensionsSyncEffect` subscribes to the block, mirrors
 *     each change into the localStorage cache, and dispatches
 *     `refreshAppRuntime` whenever the canonical state diverges.
 */
import {appEffectsFacet} from '@/extensions/core.js'
import type {AppExtension} from '@/facets/facet.js'
import {propertySchemasFacet} from '@/data/facets.js'
import {pluginPrefsExtension} from '@/data/pluginStateExtensions.js'
import {
  extensionsOverridesProp,
  extensionsPrefsType,
} from './config.ts'
import {extensionsSyncEffect} from './effect.ts'

export const extensionsDataExtension: AppExtension = [
  propertySchemasFacet.of(extensionsOverridesProp, {source: 'extensions-settings'}),
  ...pluginPrefsExtension(extensionsPrefsType, 'extensions-settings'),
  appEffectsFacet.of(extensionsSyncEffect, {source: 'extensions-settings'}),
]

export default extensionsDataExtension
