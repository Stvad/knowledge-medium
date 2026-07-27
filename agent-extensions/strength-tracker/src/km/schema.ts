/** Block schema for the strength tracker.
 *
 *  Everything the extension records is a plain block with typed properties,
 *  so the data stays queryable via SQL, hand-editable in the outline, and
 *  meaningful even if the extension is uninstalled.
 *
 *  Log side (under the Strength Log page):
 *   - **workout** — one per session; also the live logging state, so it
 *     carries `status` (in-progress → done).
 *   - **exercise entry** — child of a workout, one per lift, with a
 *     denormalised `exercise` name + `workingWeight` so "last working weight
 *     for exercise X" is a flat scan, and a `definition` ref back to the
 *     plan block it came from.
 *   - **set** — child of an entry, one block per set; done-ness composes
 *     with the built-in todo.
 *   - **layoff** — one per detected break, child of the page.
 *
 *  Program side (blocks in the plan outline itself): **exercise definition**
 *  and **or-group**, carrying the `strength:*` properties the parser reads.
 *  The plan stays canonical and hand-written — the extension reads it and
 *  never writes it; the types exist so the outline can *declare* rather than
 *  be guessed at, and so program edits happen in your notes.
 *
 *  There is also a small **settings** block for the engine knobs the plan
 *  prose doesn't state (rollover hour, per-lift cadence, plan-root id).
 */

import {ChangeScope, seedProperty, seedType} from '@/data/api/index.js'
import {
  extensionPropertySeedKey,
  extensionTypeSeedKey,
} from '@/extensions/dynamicExtensionSeeds.js'

import type {SessionType} from '../engine/types'
import {
  ALT_CHOICE_TYPE,
  ALT_GROUP_TYPE,
  EXERCISE_DEF_TYPE,
  EXERCISE_ENTRY_TYPE,
  FIELD,
  LAYOFF_TYPE,
  SET_TYPE,
  SETTINGS_TYPE,
  STRENGTH_LOG_TYPE,
  WORKOUT_TYPE,
  type WorkoutStatus,
} from './fields'

export {
  ALT_CHOICE_TYPE,
  ALT_GROUP_TYPE,
  EXERCISE_DEF_TYPE,
  EXERCISE_ENTRY_TYPE,
  LAYOFF_TYPE,
  SET_TYPE,
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

/** The workout IS the live logging state: it's created when logging starts
 *  (in-progress) and flips to done at "Finish". History and prescription only
 *  count done workouts, so an in-progress session never feeds itself. */
export const statusProp = seedProperty<WorkoutStatus>({
  seedKey: extensionPropertySeedKey('status'),
  revision: 1,
  name: FIELD.status,
  preset: 'strict-enum',
  config: {options: [
    {value: 'in-progress', label: 'In progress'},
    {value: 'done', label: 'Done'},
  ]},
  defaultValue: 'in-progress',
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

/** The plan block this entry was performed from. A ref (not a plain id
 *  string) so it projects into real references: the definition block's
 *  backlinks become the exercise's whole logged history, and progression
 *  follows the definition through a rename that `exercise` alone would
 *  fork. Optional — a hand-written entry, or one logged before the plan
 *  block was typed, still works off the name. */
export const definitionProp = seedProperty({
  seedKey: extensionPropertySeedKey('definition'),
  revision: 1,
  name: FIELD.definition,
  preset: 'optional-ref',
  config: {targetTypes: [EXERCISE_DEF_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

/** Derived modal working weight — kept in sync with the set blocks on every write.
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

/** Which time in this session the lift is — the same 0-based number the entry
 *  block id was derived from, stored because position among siblings stops
 *  being identity as soon as the user reorders them. See `FIELD.occurrence`,
 *  and `setIndexProp` for the same decision one level down. */
export const occurrenceProp = seedProperty({
  seedKey: extensionPropertySeedKey('occurrence'),
  revision: 1,
  name: FIELD.occurrence,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  // Bookkeeping, like `setIndexProp`: the readable copy of an identity the
  // block id already fixes, so editing it is always wrong.
  hidden: true,
})

// ──── Set ────
// One block per set, child of the exercise entry, ordered by block order.
// Plain props (not a JSON blob) so "all bench sets since June" is a real query
// and a set is hand-editable like any other block.

export const weightProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-weight'),
  revision: 1,
  name: FIELD.weight,
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

export const repsProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-reps'),
  revision: 1,
  name: FIELD.reps,
  preset: 'number',
  defaultValue: 0,
  changeScope: ChangeScope.BlockDefault,
})

/** Which set of the lift this is — the same 0-based number the block id was
 *  derived from, stored because position among siblings stops being identity
 *  the moment one of them is deleted. See `FIELD.setIndex`. */
export const setIndexProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-index'),
  revision: 1,
  name: FIELD.setIndex,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
  // Bookkeeping, not something to curate beside weight and reps: it is the
  // readable copy of an identity the block id already fixes, so an edit to it
  // is always wrong. `hidden` files it under the panel's Hidden section
  // rather than offering it for editing next to the numbers that matter.
  hidden: true,
})

export const rpeProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-rpe'),
  revision: 1,
  name: FIELD.rpe,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

/** 'L' | 'R' for single-arm work, empty otherwise. */
export const sideProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-side'),
  revision: 1,
  name: FIELD.side,
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

// Done-ness is NOT a strength prop: a set block is also a `todo`, so the
// accepted state is the todo plugin's `status` (open|done) — see store.ts,
// where each set gets the todo type + status, and history.ts, which reads it.

export const completedAtProp = seedProperty({
  seedKey: extensionPropertySeedKey('set-completed-at'),
  revision: 1,
  name: FIELD.completedAt,
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

// ──── or-group choice ────
// Which option of a plan `or`-group the user is tracking. One block per
// answered group, under the settings block — user state, so the plan outline
// stays canonical and the extension never writes it. Both ends are refs: the
// group and the option each list the choice in their backlinks, and deleting
// an option leaves a dangling link you can see rather than a map entry that
// silently stops matching.

export const choiceGroupProp = seedProperty({
  seedKey: extensionPropertySeedKey('choice-group'),
  revision: 1,
  name: FIELD.choiceGroup,
  preset: 'optional-ref',
  config: {targetTypes: [ALT_GROUP_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

export const choiceOptionProp = seedProperty({
  seedKey: extensionPropertySeedKey('choice-option'),
  revision: 1,
  name: FIELD.choiceOption,
  preset: 'optional-ref',
  config: {targetTypes: [EXERCISE_DEF_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.UserPrefs,
})

// ──── Program (blocks in the plan outline) ────
// The plan is hand-written and canonical; these properties are the
// machine-readable half of a line the parser would otherwise have to infer
// from prose. All optional: absent means "read the prose", which is why a
// hand-typed `3×6–10` still works. Declaring them buys typed editors on the
// plan block itself — you tune the program in the outline, not in code.

export const targetSetsProp = seedProperty({
  seedKey: extensionPropertySeedKey('target-sets'),
  revision: 1,
  name: FIELD.targetSets,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const repMinProp = seedProperty({
  seedKey: extensionPropertySeedKey('rep-min'),
  revision: 1,
  name: FIELD.repMin,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const repMaxProp = seedProperty({
  seedKey: extensionPropertySeedKey('rep-max'),
  revision: 1,
  name: FIELD.repMax,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const incrementProp = seedProperty({
  seedKey: extensionPropertySeedKey('increment'),
  revision: 1,
  name: FIELD.increment,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const perSideProp = seedProperty({
  seedKey: extensionPropertySeedKey('per-side'),
  revision: 1,
  name: FIELD.perSide,
  preset: 'boolean',
  defaultValue: false,
  changeScope: ChangeScope.BlockDefault,
})

/** main | accessory | carry | bodyweight — kept as free text rather than an
 *  enum: it's a human classification the parser only consults for the two
 *  values that change behaviour, and a plan should be able to invent a word
 *  without the property rejecting the write. */
export const kindProp = seedProperty({
  seedKey: extensionPropertySeedKey('kind'),
  revision: 1,
  name: FIELD.kind,
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const catchUpIncrementProp = seedProperty({
  seedKey: extensionPropertySeedKey('catch-up-increment'),
  revision: 1,
  name: FIELD.catchUpIncrement,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

export const catchUpRpeProp = seedProperty({
  seedKey: extensionPropertySeedKey('catch-up-rpe'),
  revision: 1,
  name: FIELD.catchUpRpe,
  preset: 'optional-number',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

/** Which option an `or`-group tracks until the user picks another. A ref to
 *  the option block, so renaming the option doesn't silently reset the slot
 *  to the first alternative (the parser still accepts a bare name for a
 *  hand-written plan). */
export const altDefaultProp = seedProperty({
  seedKey: extensionPropertySeedKey('alt-default'),
  revision: 2,
  name: FIELD.altDefault,
  preset: 'optional-ref',
  config: {targetTypes: [EXERCISE_DEF_TYPE]},
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
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
  properties: [sessionProp, dateProp, statusProp],
})

export const exerciseEntryType = seedType({
  seedKey: extensionTypeSeedKey('exercise'),
  // 2: `occurrenceProp` joined the declared shape, for the same reason
  // `setIndexProp` joined the set's — an entry that leaves its own identity
  // field out of what an entry IS.
  revision: 2,
  id: EXERCISE_ENTRY_TYPE,
  label: 'Exercise entry',
  description: 'One lift within a workout; its sets are child set blocks.',
  hideFromCompletion: true,
  properties: [
    exerciseProp,
    definitionProp,
    workingWeightProp,
    unitProp,
    prescribedWeightProp,
    prescribedSetsProp,
    occurrenceProp,
  ],
})

/** An exercise as the *program* defines it — a line in the plan outline, not
 *  a logged performance. Deliberately completable (unlike the log types): you
 *  add a lift to the program by typing it into your notes and typing the
 *  block, and the property editors then spell out what the parser reads. */
export const exerciseDefType = seedType({
  seedKey: extensionTypeSeedKey('exercise-def'),
  revision: 1,
  id: EXERCISE_DEF_TYPE,
  label: 'Exercise (program)',
  description: 'An exercise the program prescribes — a line in the plan outline.',
  properties: [
    targetSetsProp,
    repMinProp,
    repMaxProp,
    incrementProp,
    perSideProp,
    kindProp,
    catchUpIncrementProp,
    catchUpRpeProp,
  ],
})

/** A slot the plan fills with one of several exercises ("or"): its children
 *  are the options, one of which is tracked at a time. */
export const altGroupType = seedType({
  seedKey: extensionTypeSeedKey('alt-group'),
  revision: 1,
  id: ALT_GROUP_TYPE,
  label: 'Exercise options',
  description: 'An either/or slot in the program; its children are the options.',
  properties: [altDefaultProp],
})

export const setType = seedType({
  seedKey: extensionTypeSeedKey('set'),
  // 2: `setIndexProp` joined the declared shape. Every set stores it and the
  // read path places sets by it, so a set type that didn't name it left its
  // own identity field out of what a set IS.
  revision: 2,
  id: SET_TYPE,
  label: 'Set',
  description: 'One set within an exercise entry.',
  hideFromCompletion: true,
  properties: [weightProp, repsProp, setIndexProp, rpeProp, sideProp, completedAtProp],
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

export const altChoiceType = seedType({
  seedKey: extensionTypeSeedKey('alt-choice'),
  revision: 1,
  id: ALT_CHOICE_TYPE,
  label: 'Exercise choice',
  description: 'Which option of an or-group is currently tracked.',
  hideFromCompletion: true,
  properties: [choiceGroupProp, choiceOptionProp],
})

export const STRENGTH_TYPES = [
  strengthLogType,
  workoutType,
  exerciseEntryType,
  setType,
  layoffType,
  settingsType,
  exerciseDefType,
  altGroupType,
  altChoiceType,
]

export const STRENGTH_PROPS = [
  sessionProp,
  dateProp,
  statusProp,
  exerciseProp,
  definitionProp,
  workingWeightProp,
  unitProp,
  prescribedWeightProp,
  prescribedSetsProp,
  occurrenceProp,
  weightProp,
  repsProp,
  setIndexProp,
  rpeProp,
  sideProp,
  completedAtProp,
  layoffFromProp,
  layoffToProp,
  layoffDaysProp,
  layoffTierProp,
  layoffPctProp,
  planRootProp,
  rolloverHourProp,
  cadenceDaysProp,
  roundToProp,
  choiceGroupProp,
  choiceOptionProp,
  targetSetsProp,
  repMinProp,
  repMaxProp,
  incrementProp,
  perSideProp,
  kindProp,
  catchUpIncrementProp,
  catchUpRpeProp,
  altDefaultProp,
]
