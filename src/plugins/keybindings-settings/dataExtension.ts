import {actionsFacet, appEffectsFacet} from '@/extensions/core.js'
import {propertyEditorOverridesFacet, propertySchemasFacet} from '@/data/facets.js'
import {pluginPrefsExtension} from '@/data/pluginStateExtensions.js'
import type {AppExtension} from '@/facets/facet.js'
import {openKeybindingsSettingsAction} from './actions.ts'
import {keybindingOverridesProp, keybindingsPrefsType} from './config.ts'
import {keybindingsSyncEffect} from './effect.ts'
import {keybindingsOverridesUi} from './propertyEditorOverride.ts'

// NOTE: the user's saved overrides are emitted as facet contributions
// by `buildUserKeybindingContributions` in AppRuntimeProvider — they
// can't live in this static extension tree because the
// per-workspace cache read needs `workspaceId`, which only the
// React render layer knows. The plugin owns the schema, sub-block,
// effect (cache mirror), and editor UI; AppRuntimeProvider does the
// final merge into the static tree.
export const keybindingsSettingsDataExtension: AppExtension = [
  propertySchemasFacet.of(keybindingOverridesProp, {source: 'keybindings-settings'}),
  propertyEditorOverridesFacet.of(keybindingsOverridesUi, {source: 'keybindings-settings'}),
  ...pluginPrefsExtension(keybindingsPrefsType, 'keybindings-settings'),
  appEffectsFacet.of(keybindingsSyncEffect, {source: 'keybindings-settings'}),
  actionsFacet.of(openKeybindingsSettingsAction, {source: 'keybindings-settings'}),
]
