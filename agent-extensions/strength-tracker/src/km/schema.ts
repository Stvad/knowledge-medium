/** Block schema for the strength tracker.
 *
 *  Everything the extension records is a plain block with typed properties,
 *  so the data stays queryable via SQL, hand-editable in the outline, and
 *  meaningful even if the extension is uninstalled. Three record types:
 *
 *   - **workout** — one per session, child of the Strength Log page.
 *   - **exercise entry** — child of a workout, one per lift. Its sets live
 *     in a single `sets` JSON property (block-prop, not a child-per-set
 *     tree) plus a denormalised `workingWeight`/`exercise`/`date` trio so
 *     the plan's hard requirement — "last working weight for exercise X"
 *     via SQL — is a flat scan, not a tree walk. The extension keeps the
 *     derived trio in step with `sets` on every write.
 *   - **layoff** — one per detected break, child of the page.
 *
 *  There is also a small **settings** block for the engine knobs the plan
 *  prose doesn't state (rollover hour, per-lift cadence, plan-root id).
 *  The program *content* — exercises, rep ranges, re-entry percentages,
 *  milestones — is read live from the plan outline, never from here.
 */

import {ChangeScope, seedProperty, seedType} from '@/data/api/index.js'
import {
  extensionPropertySeedKey,
  extensionTypeSeedKey,
} from '@/extensions/dynamicExtensionSeeds.js'

import type {SessionType} from '../engine/types'
import {
  EXERCISE_ENTRY_TYPE,
  FIELD,
  LAYOFF_TYPE,
  SETTINGS_TYPE,
  STRENGTH_LOG_TYPE,
  WORKOUT_TYPE,
  type StoredSet,
} from './fields'

export {
  EXERCISE_ENTRY_TYPE,
  LAYOFF_TYPE,
  SETTINGS_TYPE,
  STRENGTH_LOG_TYPE,
  WORKOUT_TYPE,
  type StoredSet,
} from './fields'

// ──── Workout ────

export const sessionProp = seedProperty<SessionType>({
  seedKey: extensionPropertySeedKey('session'),
  revision: 1,
  name: FIELD.session,
  preset: 'strict-enum',
  config: {options: [
    {value: 'A', label: 'A · upper-lean'},
    {value: 'B', label: 'B · lower-lean'},
    {value: 'mini', label: 'mini'},
  ]},
  defaultValue: 'A',
  changeScope: ChangeScope.BlockDefault,
})

/** Training day (YYYY-MM-DD), stored as a date. Distinct from the row's
 *  created_at: a 1am Sunday session is logged Monday but dated Sunday. */
export const dateProp = seedProperty({
  seedKey: extensionPropertySeedKey('date'),
  revision: 1,
  name: FIELD.date,
  preset: 'date',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// ──── Exercise entry ────

/** Canonical exercise name — the join key against the program config and
 *  the field SQL groups by. Denormalised onto the entry (rather than only
 *  living in content) so "all bench sets since June" is a flat query. */
export const exerciseProp = seedProperty({
  seedKey: extensionPropertySeedKey('exercise'),
  revision: 1,
  name: FIELD.exercise,
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

/** The sets, in order. One JSON property rather than a child block per set
 *  — a completed workout is ~20 rows this way instead of ~60, which matters
 *  for 1am logging and sync, and the set list is naturally atomic. */
export const setsProp = seedProperty<readonly StoredSet[]>({
  seedKey: extensionPropertySeedKey('sets'),
  revision: 1,
  name: FIELD.sets,
  preset: 'json',
  defaultValue: [],
  changeScope: ChangeScope.BlockDefault,
})

/** Derived modal working weight — kept in sync with `sets` on every write.
 *  Exists purely so the plan's SQL requirement is a flat column read; the
 *  engine always recomputes from `sets`, never trusts this. */
export const workingWeightProp = seedProperty({
  seedKey: extensionPropertySeedKey('working-weight'),
  revision: 1,
  name: FIELD.workingWeight,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const unitProp = seedProperty({
  seedKey: extensionPropertySeedKey('unit'),
  revision: 1,
  name: FIELD.unit,
  preset: 'string',
  defaultValue: 'lb',
  changeScope: ChangeScope.BlockDefault,
})

/** What the engine prescribed at log time — kept so progression judges
 *  "all prescribed sets" against the live prescription, not today's config. */
export const prescribedWeightProp = seedProperty({
  seedKey: extensionPropertySeedKey('prescribed-weight'),
  revision: 1,
  name: FIELD.prescribedWeight,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const prescribedSetsProp = seedProperty({
  seedKey: extensionPropertySeedKey('prescribed-sets'),
  revision: 1,
  name: FIELD.prescribedSets,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// ──── Layoff ────

export const layoffFromProp = seedProperty({
  seedKey: extensionPropertySeedKey('layoff-from'),
  revision: 1,
  name: FIELD.layoffFrom,
  preset: 'date',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const layoffToProp = seedProperty({
  seedKey: extensionPropertySeedKey('layoff-to'),
  revision: 1,
  name: FIELD.layoffTo,
  preset: 'date',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const layoffDaysProp = seedProperty({
  seedKey: extensionPropertySeedKey('layoff-days'),
  revision: 1,
  name: FIELD.layoffDays,
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

export const layoffTierProp = seedProperty({
  seedKey: extensionPropertySeedKey('layoff-tier'),
  revision: 1,
  name: FIELD.layoffTier,
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

export const layoffPctProp = seedProperty({
  seedKey: extensionPropertySeedKey('layoff-pct'),
  revision: 1,
  name: FIELD.layoffPct,
  preset: 'number',
  defaultValue: 1,
  changeScope: ChangeScope.BlockDefault,
})

// ──── Settings ────

/** Block id of the plan outline root the config is read from. Defaults to
 *  the known Strength Plan v2 root; editable so the same extension works in
 *  a workspace where the plan lives elsewhere. */
export const planRootProp = seedProperty({
  seedKey: extensionPropertySeedKey('plan-root'),
  revision: 1,
  name: FIELD.planRoot,
  preset: 'string',
  defaultValue: '',
  changeScope: ChangeScope.UserPrefs,
})

export const rolloverHourProp = seedProperty({
  seedKey: extensionPropertySeedKey('rollover-hour'),
  revision: 1,
  name: FIELD.rolloverHour,
  preset: 'number',
  defaultValue: 4,
  changeScope: ChangeScope.UserPrefs,
})

export const cadenceDaysProp = seedProperty({
  seedKey: extensionPropertySeedKey('cadence-days'),
  revision: 1,
  name: FIELD.cadenceDays,
  preset: 'number',
  defaultValue: 9,
  changeScope: ChangeScope.UserPrefs,
})

export const roundToProp = seedProperty({
  seedKey: extensionPropertySeedKey('round-to'),
  revision: 1,
  name: FIELD.roundTo,
  preset: 'number',
  defaultValue: 5,
  changeScope: ChangeScope.UserPrefs,
})

// ──── Types ────

export const strengthLogType = seedType({
  seedKey: extensionTypeSeedKey('log'),
  revision: 1,
  id: STRENGTH_LOG_TYPE,
  label: 'Strength Log',
  description: 'The page that holds logged workouts and layoffs.',
  hideFromCompletion: true,
})

export const workoutType = seedType({
  seedKey: extensionTypeSeedKey('workout'),
  revision: 1,
  id: WORKOUT_TYPE,
  label: 'Workout',
  description: 'A logged strength session (A / B / mini).',
  properties: [sessionProp, dateProp],
})

export const exerciseEntryType = seedType({
  seedKey: extensionTypeSeedKey('exercise'),
  revision: 1,
  id: EXERCISE_ENTRY_TYPE,
  label: 'Exercise entry',
  description: 'One lift within a workout, with its logged sets.',
  hideFromCompletion: true,
  properties: [
    exerciseProp,
    setsProp,
    workingWeightProp,
    unitProp,
    prescribedWeightProp,
    prescribedSetsProp,
  ],
})

export const layoffType = seedType({
  seedKey: extensionTypeSeedKey('layoff'),
  revision: 1,
  id: LAYOFF_TYPE,
  label: 'Layoff',
  description: 'A detected training break, with the re-entry tier applied.',
  properties: [layoffFromProp, layoffToProp, layoffDaysProp, layoffTierProp, layoffPctProp],
})

export const settingsType = seedType({
  seedKey: extensionTypeSeedKey('settings'),
  revision: 1,
  id: SETTINGS_TYPE,
  label: 'Strength settings',
  description: 'Engine knobs the plan prose does not state.',
  hideFromCompletion: true,
  properties: [planRootProp, rolloverHourProp, cadenceDaysProp, roundToProp],
})

export const STRENGTH_TYPES = [strengthLogType, workoutType, exerciseEntryType, layoffType, settingsType]

export const STRENGTH_PROPS = [
  sessionProp,
  dateProp,
  exerciseProp,
  setsProp,
  workingWeightProp,
  unitProp,
  prescribedWeightProp,
  prescribedSetsProp,
  layoffFromProp,
  layoffToProp,
  layoffDaysProp,
  layoffTierProp,
  layoffPctProp,
  planRootProp,
  rolloverHourProp,
  cadenceDaysProp,
  roundToProp,
]
