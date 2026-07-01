import {appEffectsFacet} from '@/extensions/core.js'
import {propertySchemasFacet} from '@/data/facets.js'
import {pluginPrefsExtension} from '@/data/pluginStateExtensions.js'
import type {AppExtension} from '@/facets/facet.js'
import {keybindingOverridesProp, keybindingsPrefsType} from './config.ts'
import {keybindingsSyncEffect} from './effect.ts'

// DATA ONLY — graph-free for the `pluginDataExtensions` glob. The editor UI
// and the "Keyboard shortcuts" command-palette action (handler imports
// `navigate` → React) live in `./index.ts`.
//
// NOTE: the user's saved overrides are emitted as facet contributions
// by `buildUserKeybindingContributions` in AppRuntimeProvider — they
// can't live in this static extension tree because the
// per-workspace cache read needs `workspaceId`, which only the
// React render layer knows. The plugin owns the schema, sub-block,
// effect (cache mirror), and editor UI; AppRuntimeProvider does the
// final merge into the static tree.
export const keybindingsSettingsDataExtension: AppExtension = [
  propertySchemasFacet.of(keybindingOverridesProp, {source: 'keybindings-settings'}),
  ...pluginPrefsExtension(keybindingsPrefsType, 'keybindings-settings'),
  appEffectsFacet.of(keybindingsSyncEffect, {source: 'keybindings-settings'}),
]

export default keybindingsSettingsDataExtension
