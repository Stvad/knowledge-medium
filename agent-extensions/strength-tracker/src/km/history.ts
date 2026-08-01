/** Pure block → record readers: take the raw rows a typed-block query
 *  returns and assemble the engine's `WorkoutRecord` / `LayoffRecord` shapes.
 *  Import only field names and plain helpers — no runtime `@/` module — so
 *  the mapping is unit-testable in a plain node environment. Property values
 *  on a row are codec-*encoded*: dates are ISO strings, everything else
 *  round-trips as identity JSON — so the only decode needed here is
 *  ISO-string → Date for the two date fields.
 */

import {compareRecords} from '../engine/types'
import type {LayoffRecord, SessionType, SetRecord, WorkoutRecord} from '../engine/types'
import {dateToDay} from './day'
import {FIELD} from './fields'

/** Minimal shape the readers need — a structural subset of the app's
 *  `BlockData`, so the real rows satisfy it without importing its type. */
export interface RowLike {
  id: string
  parentId: string | null
  orderKey: string
  properties: Record<string, unknown>
}

const num = (row: RowLike, name: string, fallback: number): number => {
  const raw = row.properties[name]
  return typeof raw === 'number' ? raw : fallback
}

const optNum = (row: RowLike, name: string): number | undefined => {
  const raw = row.properties[name]
  return typeof raw === 'number' ? raw : undefined
}

const str = (row: RowLike, name: string, fallback = ''): string => {
  const raw = row.properties[name]
  return typeof raw === 'string' ? raw : fallback
}

const optStr = (row: RowLike, name: string): string | undefined => {
  const raw = row.properties[name]
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined
}

const date = (row: RowLike, name: string): Date | undefined => {
  const raw = row.properties[name]
  if (typeof raw !== 'string') return undefined
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? undefined : d
}

/** A set is accepted when its composed todo `status` is done. */
const isDone = (row: RowLike): boolean => row.properties[FIELD.todoStatus] === 'done'

const side = (row: RowLike, name: string): 'L' | 'R' | undefined => {
  const raw = row.properties[name]
  return raw === 'L' || raw === 'R' ? raw : undefined
}

const compareByOrderKey = (a: RowLike, b: RowLike): number =>
  a.orderKey < b.orderKey ? -1 : a.orderKey > b.orderKey ? 1 : a.id < b.id ? -1 : 1

const groupByParent = (rows: readonly RowLike[]): Map<string, RowLike[]> => {
  const byParent = new Map<string, RowLike[]>()
  for (const row of rows) {
    if (row.parentId === null) continue
    const list = byParent.get(row.parentId) ?? []
    list.push(row)
    byParent.set(row.parentId, list)
  }
  return byParent
}

/** A done set block → the engine's `SetRecord`. */
const toSetRecord = (row: RowLike): SetRecord => ({
  weight: num(row, FIELD.weight, 0),
  reps: num(row, FIELD.reps, 0),
  ...(optNum(row, FIELD.rpe) !== undefined ? {rpe: optNum(row, FIELD.rpe)} : {}),
  ...(side(row, FIELD.side) !== undefined ? {side: side(row, FIELD.side)} : {}),
})

/** Assemble workout records from the workout / exercise / set block trees.
 *  Only DONE workouts count as history (an in-progress session must never
 *  feed its own prescription), and only DONE sets within a workout (a
 *  pre-filled, un-accepted set records nothing). */
export const buildHistory = (
  workoutRows: readonly RowLike[],
  exerciseRows: readonly RowLike[],
  setRows: readonly RowLike[],
): WorkoutRecord[] => {
  const exercisesByWorkout = groupByParent(exerciseRows)
  const setsByExercise = groupByParent(setRows)

  const workouts: WorkoutRecord[] = []
  for (const row of workoutRows) {
    const d = date(row, FIELD.date)
    if (d === undefined) continue
    if (str(row, FIELD.status) === 'in-progress') continue
    const entries = (exercisesByWorkout.get(row.id) ?? []).slice().sort(compareByOrderKey)
    const session = str(row, FIELD.session, 'A') as SessionType
    // When the work was actually done, for telling two sessions of one day
    // apart — `date` is that day's local noon on both. See `compareRecords`.
    let recordedAt: number | undefined
    for (const entry of entries) {
      for (const set of setsByExercise.get(entry.id) ?? []) {
        if (!isDone(set)) continue
        const at = optNum(set, FIELD.completedAt)
        if (at !== undefined && (recordedAt === undefined || at > recordedAt)) recordedAt = at
      }
    }
    // Falling back to the workout's own finish stamp: the set-derived value
    // above is the truer time when it is there (a set ticked live carries
    // when it was actually done), but it empties out the moment a correction
    // leaves every done set without a `completedAt`. Sessions closed before
    // that property existed have neither, which is the behaviour they already
    // had. See `finishedAtProp`.
    const orderedAt = recordedAt ?? optNum(row, FIELD.finishedAt)
    workouts.push({
      id: row.id,
      date: d.toISOString(),
      session,
      ...(orderedAt !== undefined ? {recordedAt: orderedAt} : {}),
      exercises: entries.map(entry => ({
        exercise: str(entry, FIELD.exercise),
        definitionId: optStr(entry, FIELD.definition),
        occurrence: optNum(entry, FIELD.occurrence),
        prescribedWeight: optNum(entry, FIELD.prescribedWeight),
        prescribedSets: optNum(entry, FIELD.prescribedSets),
        sets: (setsByExercise.get(entry.id) ?? [])
          .slice()
          .sort(compareByOrderKey)
          .filter(isDone)
          .map(toSetRecord),
      })),
    })
  }
  return workouts.sort(compareRecords)
}

/** `|` separates the parts of every identity string here, so a lift whose
 *  NAME contains one could spell another row's identity: "Bench|1" at
 *  occurrence 0 and "Bench" at occurrence 1 both read as `Bench|1`, and two
 *  different lifts would share one entry block. Escaping makes the parts
 *  recoverable. Exported for `session.ts`, which spells the same identity
 *  into a derived block id and must escape it identically. */
export const escapeKeyPart = (part: string): string => part.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

/** `{groupId: optionId}` from the `or`-group choice blocks (children of the
 *  settings block). One block per answered group; a group with no block is
 *  absent, and falls back to the plan's own default. Pure, so the mapping is
 *  testable without a repo. */
export const buildAltChoices = (rows: readonly RowLike[]): Record<string, string> => {
  const choices: Record<string, string> = {}
  for (const row of rows) {
    const group = row.properties[FIELD.choiceGroup]
    const option = row.properties[FIELD.choiceOption]
    if (typeof group === 'string' && group && typeof option === 'string' && option) {
      choices[group] = option
    }
  }
  return choices
}

export const buildLayoffs = (layoffRows: readonly RowLike[]): LayoffRecord[] => {
  const layoffs: LayoffRecord[] = []
  for (const row of layoffRows) {
    const from = date(row, FIELD.layoffFrom)
    const to = date(row, FIELD.layoffTo)
    if (from === undefined || to === undefined) continue
    layoffs.push({
      id: row.id,
      from: dateToDay(from),
      to: dateToDay(to),
      days: num(row, FIELD.layoffDays, 0),
      tierId: str(row, FIELD.layoffTier),
      pct: num(row, FIELD.layoffPct, 1),
    })
  }
  return layoffs.sort((a, b) => a.to.localeCompare(b.to))
}
