/**
 * How the outline shows a block's PROPERTY CHILDREN on a child-backed
 * workspace (docs/properties-as-blocks-migration.html §10, issue #1674).
 *
 * Three modes, each a view over the same structural children:
 *   - `all`        every property row, hidden-tier definitions included;
 *   - `non-hidden` property rows whose definition is not hidden;
 *   - `none`       no property rows — the outline before properties-as-blocks.
 *
 * The mode is set at three levels, most specific wins: block > panel >
 * workspace (a per-user preference). {@link resolvePropertyDisplayMode} is the
 * ONE place they combine; every reader asks it rather than layering levels itself.
 * A cell-backed workspace is always `none`: its property children (minted by
 * the backfill) are not the source of truth and must not be edited in place.
 */

import { z } from 'zod'
import { ChangeScope, seedType } from '@/data/api'
import type { PropertyChildrenView } from '@/data/api'
import { seedProperty } from './propertySeeds'

export const PROPERTY_DISPLAY_MODES = ['all', 'non-hidden', 'none'] as const satisfies readonly PropertyChildrenView[]
/** The mode IS the child listing it shows (`core.childIds` / `core.children`'s
 *  `propertyChildren`): one type, so no translation between them. */
export type PropertyDisplayMode = PropertyChildrenView

/** A level's stored setting: a mode, or `inherit` (unset — the next less
 *  specific level decides). */
export type PropertyDisplaySetting = PropertyDisplayMode | 'inherit'

/** What an un-switched user sees on a child-backed workspace. `none` while
 *  the rows roll out: identical to the outline before them, so changing this
 *  default is the switch-over. */
export const DEFAULT_PROPERTY_DISPLAY_MODE: PropertyDisplayMode = 'none'

export const PROPERTY_DISPLAY_MODE_LABELS: Record<PropertyDisplayMode, string> = {
  'all': 'Show all properties',
  'non-hidden': 'Show non-hidden properties',
  'none': 'Hide all properties',
}

const settingOptions = [
  {value: 'inherit' as const, label: 'Default'},
  ...PROPERTY_DISPLAY_MODES.map(value => ({value, label: PROPERTY_DISPLAY_MODE_LABELS[value]})),
]

/** Block level: this block's own children list. The doc's per-block "show
 *  hidden properties" reveal is this set to `all`. On the block, like
 *  `showPropertiesProp`, and not undoable for the same reason. */
export const propertyDisplayProp = seedProperty<PropertyDisplaySetting>({
  seedKey: 'system:kernel-data/property/property-display',
  revision: 1,
  name: 'system:propertyDisplay',
  preset: 'strict-enum',
  config: {options: settingOptions},
  defaultValue: 'inherit',
  changeScope: ChangeScope.UiState,
  hidden: true,
})

/** Workspace level: one user's choice for the whole workspace, on their
 *  prefs block, so switching it changes nobody else's view. */
export const propertyDisplayDefaultProp = seedProperty<PropertyDisplaySetting>({
  seedKey: 'system:kernel-data/property/property-display-default',
  revision: 1,
  name: 'system:propertyDisplayDefault',
  preset: 'strict-enum',
  config: {options: settingOptions},
  defaultValue: 'inherit',
  changeScope: ChangeScope.UserPrefs,
  hidden: true,
})

export const propertyDisplayPrefsType = seedType({
  seedKey: 'system:kernel-data/type/property-display-prefs',
  revision: 1,
  id: 'property-display-prefs',
  label: 'Property display',
  hideFromCompletion: true,
  properties: [propertyDisplayDefaultProp],
})

/** The block level's stored setting on `data`, tolerantly (below). */
export const blockPropertyDisplaySetting = (
  data: {readonly properties: Readonly<Record<string, unknown>>} | null | undefined,
): PropertyDisplaySetting => parsePropertyDisplaySetting(data?.properties[propertyDisplayProp.name])

/** A stored setting read TOLERANTLY: anything but a known value is `inherit`.
 *  Every rendered block reads one, above the per-block error boundary, so a
 *  malformed value from sync or a hand edit must degrade, never throw. */
export const parsePropertyDisplaySetting = (raw: unknown): PropertyDisplaySetting =>
  typeof raw === 'string' && (PROPERTY_DISPLAY_MODES as readonly string[]).includes(raw)
    ? raw as PropertyDisplayMode
    : 'inherit'

export interface PropertyDisplayLevels {
  /** Whether the workspace reads properties from children. False forces `none`. */
  readonly childBacked: boolean
  readonly workspace: PropertyDisplaySetting
  /** Reserved for a per-panel switch; nothing sets it yet. */
  readonly panel: PropertyDisplaySetting
  readonly block: PropertyDisplaySetting
}

/** The levels above the block — workspace and panel — as a surface supplies
 *  them (`PropertyDisplayScope` per panel). A gesture or copy carries the
 *  scope of the surface it ran in, so it acts on the list that surface draws. */
export type PropertyDisplayScopeLevels = Omit<PropertyDisplayLevels, 'block'>

/** No surface: a cell-backed reading, so mode `none` — the outline before
 *  property rows. What a caller without a surface (the bridge, a plugin)
 *  gets. */
export const NO_PROPERTY_DISPLAY_SCOPE: PropertyDisplayScopeLevels = Object.freeze({
  childBacked: false,
  workspace: 'inherit',
  panel: 'inherit',
})

/** The scope a gesture, paste or mutator call carries, or
 *  {@link NO_PROPERTY_DISPLAY_SCOPE} when it carries none (the bridge, a
 *  global command, a plugin). The ONE place an absent scope becomes mode
 *  `none`: the children readers below this take a scope, never a default. */
export const displayScopeOf = (
  carrier: {readonly propertyDisplay?: PropertyDisplayScopeLevels},
): PropertyDisplayScopeLevels => carrier.propertyDisplay ?? NO_PROPERTY_DISPLAY_SCOPE

/** The mode for one block in one panel. */
export const resolvePropertyDisplayMode = (levels: PropertyDisplayLevels): PropertyDisplayMode => {
  if (!levels.childBacked) return 'none'
  for (const setting of [levels.block, levels.panel, levels.workspace]) {
    if (setting !== 'inherit') return setting
  }
  return DEFAULT_PROPERTY_DISPLAY_MODE
}

const NEXT_PROPERTY_DISPLAY_MODE: Record<PropertyDisplayMode, PropertyDisplayMode> = {
  none: 'non-hidden', 'non-hidden': 'all', all: 'none',
}

/** Cycle the effective mode, storing `inherit` when the scope already supplies
 *  the target so later workspace or panel changes still reach this block. */
export const nextBlockPropertyDisplaySetting = (levels: PropertyDisplayLevels): PropertyDisplaySetting => {
  const mode = NEXT_PROPERTY_DISPLAY_MODE[resolvePropertyDisplayMode(levels)]
  return mode === resolvePropertyDisplayMode({...levels, block: 'inherit'}) ? 'inherit' : mode
}

/** The child listing of `parent` that a surface with `scope` draws: the
 *  parent's own block setting over the scope. `parent` is null for a
 *  workspace-root listing, which has no block setting. */
export const childrenViewIn = (
  scope: PropertyDisplayScopeLevels,
  parent: {readonly properties: Readonly<Record<string, unknown>>} | null,
): PropertyDisplayMode =>
  resolvePropertyDisplayMode({...scope, block: blockPropertyDisplaySetting(parent)})

export const propertyDisplayScopeSchema = z.object({
  childBacked: z.boolean(),
  workspace: z.enum(['inherit', ...PROPERTY_DISPLAY_MODES]),
  panel: z.enum(['inherit', ...PROPERTY_DISPLAY_MODES]),
})
