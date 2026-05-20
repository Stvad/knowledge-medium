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
import {appEffectsFacet} from '@/extensions/core.ts'
import type {AppExtension} from '@/extensions/facet.ts'
import {propertySchemasFacet} from '@/data/facets.ts'
import {pluginPrefsExtension} from '@/data/pluginStateExtensions.ts'
import {
  systemPluginOverridesProp,
  systemPluginsPrefsType,
} from './config.ts'
import {systemPluginsSyncEffect} from './effect.ts'
import {legacyDisableMigrationEffect} from './migration.ts'

export const systemPluginsDataExtension: AppExtension = [
  propertySchemasFacet.of(systemPluginOverridesProp, {source: 'system-plugins'}),
  ...pluginPrefsExtension(systemPluginsPrefsType, 'system-plugins'),
  appEffectsFacet.of(systemPluginsSyncEffect, {source: 'system-plugins'}),
  // One-shot migration: folds legacy `extensionDisabledProp === true`
  // on individual extension blocks into the unified overrides map.
  // Idempotent — once cleared, re-runs are no-ops.
  appEffectsFacet.of(legacyDisableMigrationEffect, {source: 'system-plugins'}),
]
