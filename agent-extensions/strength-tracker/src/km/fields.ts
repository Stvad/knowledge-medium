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
export const LAYOFF_TYPE = 'strength-layoff'
export const SETTINGS_TYPE = 'strength-settings'

export const FIELD = {
  session: 'strength:session',
  date: 'strength:date',
  exercise: 'strength:exercise',
  sets: 'strength:sets',
  workingWeight: 'strength:workingWeight',
  unit: 'strength:unit',
  prescribedWeight: 'strength:prescribedWeight',
  prescribedSets: 'strength:prescribedSets',
  layoffFrom: 'strength:from',
  layoffTo: 'strength:to',
  layoffDays: 'strength:gapDays',
  layoffTier: 'strength:tier',
  layoffPct: 'strength:reentryPct',
  planRoot: 'strength:planRoot',
  rolloverHour: 'strength:rolloverHour',
  cadenceDays: 'strength:cadenceDays',
  roundTo: 'strength:roundTo',
} as const

export interface StoredSet {
  weight: number
  reps: number
  rpe?: number
  side?: 'L' | 'R'
}
