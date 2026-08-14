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
/** One row of the plan's re-entry table. Declared rather than read out of the
 *  sentence beside it: the prose says "drop 1 set per lift", which is both a
 *  valid delta ("one fewer") and a valid absolute ("1 set"), and no reading of
 *  the words settles which. A tier that governs how much weight goes on a bar
 *  after a layoff is not a thing to infer. */
export const REENTRY_TIER_TYPE = 'strength-reentry-tier'
/** One block per tracked or-group choice — user state, under the settings
 *  block. A block (not a map in a property) so both ends are real refs: the
 *  group and the option each see it in their backlinks, and a deleted option
 *  leaves a visible dangling link instead of a silently ignored map entry. */
export const ALT_CHOICE_TYPE = 'strength-alt-choice'

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
  prescribedReps: 'strength:prescribedReps',
  /** Which time in THIS session this lift is — 0-based.
   *
   *  Stored because position among siblings is not identity. A session can prescribe one lift twice, and counting the
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
  finishedAt: 'strength:finishedAt',
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
  // re-entry tier (a row of the plan's re-entry table). `reentryPct`,
  // `targetSets`, `repMin` and `repMax` are the SAME properties the layoff
  // record and the exercise definitions use — one vocabulary, so "90% of
  // pre-break" reads the same wherever it appears.
  /** Which row this is (`1-2w`, `2-4w`, …). Identity, not a label: the tier a
   *  gap resolves to used to come from a regex over the row's first words. */
  tierId: 'strength:tierId',
  /** Inclusive upper bound of the gap this row covers, in days. Absent keeps
   *  the built-in boundary for this tier id — the plan states gaps in weeks,
   *  and "1–2 weeks" is not a day count. */
  maxGapDays: 'strength:maxGapDays',
  /** Sets dropped from each lift's own target on the first session back. Pairs
   *  with `targetSets` (the absolute "2 sets per lift" form); a row that states
   *  both is refused rather than silently resolved. */
  setsDelta: 'strength:setsDelta',
  /** How many sessions back `targetSets` applies for. Absent = the whole ramp. */
  setsOverrideSessions: 'strength:setsOverrideSessions',
  /** Full sessions under this tier before normal progression resumes. */
  sessionsToNormal: 'strength:sessionsToNormal',
  /** Added to the percentage per session back, as a fraction (`0.05` = +5%). */
  rampPerSession: 'strength:rampPerSession',
  /** On an `or`-group: a ref to the option block to track when the user
   *  hasn't chosen one (a bare name is still accepted). */
  altDefault: 'strength:default',
  /** The app's own (un-namespaced) type-membership list — read to tell a
   *  declared exercise definition from a plain note. */
  blockTypes: 'types',
} as const

export type WorkoutStatus = 'in-progress' | 'done'
