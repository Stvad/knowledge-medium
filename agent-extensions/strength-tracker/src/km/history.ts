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
import {dateToDay, storedDate} from './day'
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
 *  feed its own prescription), only DONE sets within a workout (a pre-filled,
 *  un-ticked set records nothing) — and a closed workout left with no done
 *  sets at all is not history either. See the check at the bottom. */
export const buildHistory = (
  workoutRows: readonly RowLike[],
  exerciseRows: readonly RowLike[],
  setRows: readonly RowLike[],
): WorkoutRecord[] => {
  const exercisesByWorkout = groupByParent(exerciseRows)
  const setsByExercise = groupByParent(setRows)

  const workouts: WorkoutRecord[] = []
  for (const row of workoutRows) {
    // Normalized HERE, once: `d.toISOString()` becomes `WorkoutRecord.date`,
    // which `fullSessionDays`, `prescribe` and `compareRecords` all decode
    // again. A date typed into the property editor is UTC midnight, so without
    // this every one of those clocks reads it a day early. See `storedDate`.
    const d = date(row, FIELD.date)
    if (d === undefined) continue
    const on = storedDate(d)
    // Only `done` — not "anything that is not in-progress". A workout whose
    // status was cleared, or holds some third value, is neither live nor
    // closed (`asWorkout` says so, and the footer offers it no controls), so
    // admitting it here made a session nobody can finish or discard count as a
    // training day: it moved the layoff gap, incremented `sessionsBack` and
    // read to `resolveSession` as work recently done. The two readers now
    // agree on what "closed" means.
    if (str(row, FIELD.status) !== 'done') continue
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
    const exercises = entries.map(entry => ({
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
    }))
    // A session with nothing performed is not a training day. Finish refuses
    // to close one, so this is a CORRECTION afterwards — unticking every set,
    // which means "I did not actually do that". The blocks stay as they are.
    //
    // Dropped from HISTORY, not just from the re-entry maths: every clock keyed
    // on a session's date reads this list and none look at the sets, so an
    // emptied A/B record would reset the layoff gap, increment `sessionsBack`,
    // and read to `resolveSession` as "A was done recently".
    if (exercises.every(entry => entry.sets.length === 0)) continue
    workouts.push({
      id: row.id,
      date: on.toISOString(),
      session,
      ...(orderedAt !== undefined ? {recordedAt: orderedAt} : {}),
      exercises,
    })
  }
  return workouts.sort(compareRecords)
}

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
      from: dateToDay(storedDate(from)),
      to: dateToDay(storedDate(to)),
      days: num(row, FIELD.layoffDays, 0),
      tierId: str(row, FIELD.layoffTier),
      pct: num(row, FIELD.layoffPct, 1),
    })
  }
  return layoffs.sort((a, b) => a.to.localeCompare(b.to))
}
