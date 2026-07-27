/** Field names and type ids as plain constants — the one source of truth
 *  shared by the seed declarations (`schema.ts`) and the pure read path
 *  (`history.ts`).
 *
 *  Keeping these here, free of any `@/` import, is what lets the block →
 *  record mapping be unit-tested in a plain node environment: `schema.ts`
 *  pulls in the runtime `seedProperty` machinery, but the readers only need
 *  the names.
 */

export const STRENGTH_LOG_TYPE = 'strength-log'
export const WORKOUT_TYPE = 'strength-workout'
export const EXERCISE_ENTRY_TYPE = 'strength-exercise'
export const SET_TYPE = 'strength-set'
export const LAYOFF_TYPE = 'strength-layoff'
export const SETTINGS_TYPE = 'strength-settings'

// Program side — blocks in the plan outline itself. The plan stays
// hand-written prose, but a typed block is a declaration: it gets the
// program property editors, it's queryable ("every exercise I train"), and
// the parser reads it as intent rather than guessing from wording.
export const EXERCISE_DEF_TYPE = 'strength-exercise-def'
export const ALT_GROUP_TYPE = 'strength-alt-group'
/** One block per tracked or-group choice — user state, under the settings
 *  block. A block (not a map in a property) so both ends are real refs: the
 *  group and the option each see it in their backlinks, and a deleted option
 *  leaves a visible dangling link instead of a silently ignored map entry. */
export const ALT_CHOICE_TYPE = 'strength-alt-choice'

/** Shoulder-policy block referenced by auto-created consult todos.
 *
 *  Here rather than in `config.ts` for the reason above: it is a bare id, and
 *  the logging view needs nothing else from that module — so importing it
 *  from there pulled the whole seed + parser graph, and its `@/` runtime
 *  imports, into the view's module graph for one string. */
export const SHOULDER_POLICY_BLOCK_ID = '3f8866f6-7143-4bbe-b9a0-fa60abf12be5'

export const FIELD = {
  // workout
  session: 'strength:session',
  date: 'strength:date',
  /** in-progress | done — a workout is the live logging state, so it exists
   *  (and syncs) while being logged and flips to done at "Finish". */
  status: 'strength:status',
  // exercise entry
  exercise: 'strength:exercise',
  /** Ref to the plan's exercise-definition block. A real reference, so every
   *  logged entry shows up in the definition's backlinks ("every night I
   *  benched") and progression follows the definition across a rename —
   *  `exercise` stays as the human-readable name and the legacy join key. */
  definition: 'strength:definition',
  workingWeight: 'strength:workingWeight',
  unit: 'strength:unit',
  prescribedWeight: 'strength:prescribedWeight',
  prescribedSets: 'strength:prescribedSets',
  /** Which time in THIS session this lift is — 0-based, and the same number
   *  its block id is derived from.
   *
   *  Stored for the same reason `setIndex` is: position among siblings is not
   *  identity. A session can prescribe one lift twice, and counting the
   *  entries in block order gives the second one occurrence 1 only while
   *  nobody has reordered them — drag them past each other in the outline and
   *  the two rows swap blocks, then write each other's weights and ticks. */
  occurrence: 'strength:occurrence',
  // set (one block per set, child of the exercise entry)
  weight: 'strength:weight',
  reps: 'strength:reps',
  rpe: 'strength:rpe',
  side: 'strength:side',
  /** Done-ness composes with the built-in todo: a set block is also a `todo`,
   *  so "accepted" is the todo `status` (open|done) and every set renders as a
   *  native checkbox you can tick anywhere. This is the todo plugin's own
   *  (un-namespaced) prop name — the integration point. */
  todoStatus: 'status',
  /** Explicit completion time — kept separate rather than inferred from the
   *  row's update time (which is noisy). */
  completedAt: 'strength:completedAt',
  /** Which set of the lift this is — 0-based, and the same number its block id
   *  is derived from.
   *
   *  Stored rather than inferred from position among the siblings, because
   *  position is not identity here: delete the second of three sets and the
   *  survivors are still sets 1 and 3, but a reader counting the compacted
   *  list sees 1 and 2, hands set 3's block to the row that means set 2, and
   *  the next edit to set 3 overwrites it. The reader can't recover the
   *  number from the block id (it's a uuid) and shouldn't re-derive one, so
   *  the block says what it is. */
  setIndex: 'strength:setIndex',
  // layoff
  layoffFrom: 'strength:from',
  layoffTo: 'strength:to',
  layoffDays: 'strength:gapDays',
  layoffTier: 'strength:tier',
  layoffPct: 'strength:reentryPct',
  // settings
  planRoot: 'strength:planRoot',
  rolloverHour: 'strength:rolloverHour',
  cadenceDays: 'strength:cadenceDays',
  roundTo: 'strength:roundTo',
  // or-group choice (one block per group the user has picked in)
  /** Ref to the `or`-group being answered. */
  choiceGroup: 'strength:group',
  /** Ref to the option being tracked. */
  choiceOption: 'strength:option',
  // program (blocks in the plan outline) — the parser reads these; they
  // override whatever the prose on the same line would have implied.
  targetSets: 'strength:targetSets',
  repMin: 'strength:repMin',
  repMax: 'strength:repMax',
  increment: 'strength:increment',
  perSide: 'strength:perSide',
  /** Free-form movement classification (main | accessory | carry |
   *  bodyweight). `carry`/`bodyweight` mark work the engine never
   *  load-progresses from a rep count. */
  kind: 'strength:kind',
  catchUpIncrement: 'strength:catchUpIncrement',
  catchUpRpe: 'strength:catchUpRpe',
  /** On an `or`-group: a ref to the option block to track when the user
   *  hasn't chosen one (a bare name is still accepted). */
  altDefault: 'strength:default',
  /** The app's own (un-namespaced) type-membership list — read to tell a
   *  declared exercise definition from a plain note. */
  blockTypes: 'types',
} as const

export type WorkoutStatus = 'in-progress' | 'done'

/** In-memory shape of one logged set — reconstructed from a set block, and
 *  the unit the engine reasons over. */
export interface StoredSet {
  weight: number
  reps: number
  rpe?: number
  side?: 'L' | 'R'
  done: boolean
  /** Epoch ms when the set was marked complete during the session. */
  completedAt?: number
}
