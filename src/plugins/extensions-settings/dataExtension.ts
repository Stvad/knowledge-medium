/**
 * Extensions meta-plugin data registrations.
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
 *   - `propertyEditorOverridesFacet` registers the custom checkbox-
 *     tree editor that renders inside the prefs block's property
 *     panel — this is the actual settings UI surface.
 *   - `actionsFacet` exposes "Manage extensions" in the command
 *     palette; the handler just navigates to the prefs block in a
 *     new panel.
 */
import {actionsFacet, appEffectsFacet} from '@/extensions/core.js'
import type {AppExtension} from '@/facets/facet.js'
import {propertyEditorOverridesFacet, propertySchemasFacet, valuePresetCoresFacet} from '@/data/facets.js'
import {pluginPrefsExtension} from '@/data/pluginStateExtensions.js'
import {openExtensionsSettingsAction} from './actions.ts'
import {
  extensionsOverridesProp,
  extensionsOverridesPresetCore,
  extensionsPrefsType,
} from './config.ts'
import {extensionsSyncEffect} from './effect.ts'
import {extensionsOverridesUi} from './propertyEditorOverride.ts'

export const extensionsDataExtension: AppExtension = [
  propertySchemasFacet.of(extensionsOverridesProp, {source: 'extensions-settings'}),
  valuePresetCoresFacet.of(extensionsOverridesPresetCore, {source: 'extensions-settings'}),
  propertyEditorOverridesFacet.of(extensionsOverridesUi, {source: 'extensions-settings'}),
  ...pluginPrefsExtension(extensionsPrefsType, 'extensions-settings'),
  appEffectsFacet.of(extensionsSyncEffect, {source: 'extensions-settings'}),
  actionsFacet.of(openExtensionsSettingsAction, {source: 'extensions-settings'}),
]
