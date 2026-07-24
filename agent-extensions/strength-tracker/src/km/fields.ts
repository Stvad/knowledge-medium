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

export const FIELD = {
  // workout
  session: 'strength:session',
  date: 'strength:date',
  /** in-progress | done — a workout is the live logging state, so it exists
   *  (and syncs) while being logged and flips to done at "Finish". */
  status: 'strength:status',
  // exercise entry
  exercise: 'strength:exercise',
  workingWeight: 'strength:workingWeight',
  unit: 'strength:unit',
  prescribedWeight: 'strength:prescribedWeight',
  prescribedSets: 'strength:prescribedSets',
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
  /** JSON map {altGroupKey: chosenExerciseName} — which option of each plan
   *  `or`-group the user is currently tracking. User state, not program
   *  state, so the plan outline stays read-only. */
  altChoices: 'strength:altChoices',
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
