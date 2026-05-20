/**
 * System Plugins meta-plugin data registrations.
 *
 *   - `propertySchemasFacet` registers the overrides codec so the
 *     property reads/writes go through the strict decoder.
 *   - `pluginPrefsExtension` bundles the `typesFacet` registration
 *     for the prefs sub-block with an idle-time eager bootstrap.
 *     The bootstrap creates the block before the user navigates to
 *     Preferences, so its existence isn't gated on opening the
 *     settings UI.
 *   - `systemPluginsSyncEffect` subscribes to the block, mirrors
 *     each change into the localStorage cache, and dispatches
 *     `refreshAppRuntime` whenever the canonical state diverges.
 */
import {actionsFacet, appEffectsFacet} from '@/extensions/core.ts'
import type {AppExtension} from '@/extensions/facet.ts'
import {propertySchemasFacet} from '@/data/facets.ts'
import {pluginPrefsExtension} from '@/data/pluginStateExtensions.ts'
import {openSystemPluginsSettingsAction} from './actions.ts'
import {
  systemPluginOverridesProp,
  systemPluginsPrefsType,
} from './config.ts'
import {systemPluginsSyncEffect} from './effect.ts'
import {systemPluginsDialogMountExtension} from './SystemPluginsDialog.tsx'

export const systemPluginsDataExtension: AppExtension = [
  propertySchemasFacet.of(systemPluginOverridesProp, {source: 'system-plugins'}),
  ...pluginPrefsExtension(systemPluginsPrefsType, 'system-plugins'),
  appEffectsFacet.of(systemPluginsSyncEffect, {source: 'system-plugins'}),
  systemPluginsDialogMountExtension,
  actionsFacet.of(openSystemPluginsSettingsAction, {source: 'system-plugins'}),
]
