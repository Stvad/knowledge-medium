/** One typed view per record kind — the single place that answers "is this
 *  block one of ours, and what does it say?".
 *
 *  Every reader used to spell the answer out for itself: the type tag, then
 *  the raw status, then the date decoded through `storedDate`, then the todo
 *  status for done-ness. Each of those is a separate chance to leave one out,
 *  and over this extension's review history that is exactly what happened —
 *  four findings, each "one reader forgot one of the checks", each fixed at
 *  the site that was reported while the next site kept its copy:
 *
 *   - `isStandingToday` gated on the type tag; `discardSession` did not, so a
 *     block that had left the strength world was still cascade-deleted.
 *   - `checkFinishable` then turned out to have the same hole.
 *   - `adjustSet` accepted any live block id, so a control rendered before
 *     another pane untagged its set went on rewriting the set's numbers.
 *   - `WorkoutFooter` read `strength:status` through the schema, whose default
 *     is `in-progress`, so an untagged block read as LIVE to the footer while
 *     the two writers it offers both refused it as `gone`.
 *
 *  So the checks live here once and the readers ask. `asWorkout(null)` and
 *  `asWorkout(aDeletedRow)` are `null` too — "missing", "deleted" and "not
 *  ours" are the same answer to every caller, and folding them in is what lets
 *  a call site be `const workout = asWorkout(await tx.get(id))` with one
 *  branch after it.
 *
 *  Deliberately NOT a decoder for the training DAY. `dateToDay` and
 *  `trainingDay` disagree by design (one applies the rollover hour, one does
 *  not) and callers genuinely need both, so this normalises the instant — the
 *  part that kept going wrong — and hands it over. See `storedDate`.
 *
 *  Structural row type rather than `BlockData`, so `history.ts`'s pure rows
 *  satisfy it as well as the app's.
 */

import {hasBlockType} from '@/data/properties.js'

import type {SessionType} from '../engine/types'
import {storedDate} from './day'
import {EXERCISE_ENTRY_TYPE, FIELD, SET_TYPE, WORKOUT_TYPE} from './fields'

export interface Row {
  id: string
  properties: Record<string, unknown>
  deleted?: boolean
}

const usable = (row: Row | null | undefined, type: string): row is Row =>
  row !== null && row !== undefined && !row.deleted && hasBlockType(row, type)

const num = (row: Row, name: string): number | undefined =>
  typeof row.properties[name] === 'number' ? row.properties[name] as number : undefined

const text = (row: Row, name: string): string | undefined =>
  typeof row.properties[name] === 'string' && row.properties[name] !== ''
    ? row.properties[name] as string
    : undefined

export interface WorkoutView {
  id: string
  /** The instant the session is filed at, normalised through `storedDate`, or
   *  `null` when `strength:date` is missing or unreadable. Callers apply their
   *  own day decoder — see the module docblock. */
  on: Date | null
  session: SessionType
  /** A mini day does not end a training break, so several rules turn on this
   *  rather than on the session letter. */
  isMini: boolean
  /** The RAW `strength:status`, absent meaning absent.
   *
   *  Not read through the property schema, whose default is `in-progress`: a
   *  block hand-tagged as a Workout, or one whose status was cleared, then
   *  reads as live to whoever asked through the schema while the writers
   *  refuse it — three readers, three answers, and two controls that can never
   *  succeed. */
  status: string | undefined
  /** Still being logged into. */
  live: boolean
  /** Closed, and therefore part of history. */
  closed: boolean
}

export const asWorkout = (row: Row | null | undefined): WorkoutView | null => {
  if (!usable(row, WORKOUT_TYPE)) return null
  const raw = row.properties[FIELD.date]
  const parsed = typeof raw === 'string' ? new Date(raw) : null
  const status = text(row, FIELD.status)
  return {
    id: row.id,
    on: parsed && !Number.isNaN(parsed.getTime()) ? storedDate(parsed) : null,
    session: (text(row, FIELD.session) ?? 'A') as SessionType,
    isMini: row.properties[FIELD.session] === 'mini',
    status,
    live: status === 'in-progress',
    closed: status === 'done',
  }
}

export interface SetView {
  id: string
  /** Performed. The composed todo `status` is the ONLY thing that says so —
   *  a set block's existence means prescribed. */
  done: boolean
  weight: number | undefined
  reps: number | undefined
  unit: string | undefined
  side: 'L' | 'R' | undefined
}

export const asSet = (row: Row | null | undefined): SetView | null => {
  if (!usable(row, SET_TYPE)) return null
  const side = row.properties[FIELD.side]
  return {
    id: row.id,
    done: row.properties[FIELD.todoStatus] === 'done',
    weight: num(row, FIELD.weight),
    reps: num(row, FIELD.reps),
    unit: text(row, FIELD.unit),
    side: side === 'L' || side === 'R' ? side : undefined,
  }
}

export interface EntryView {
  id: string
  /** The lift's name as logged. Identity is `definitionId` where there is one
   *  — see `namesThisLift` — so this is for display and for the name-only
   *  fallback, not for matching. */
  exercise: string
  definitionId: string | undefined
  occurrence: number | undefined
}

export const asEntry = (row: Row | null | undefined): EntryView | null => {
  if (!usable(row, EXERCISE_ENTRY_TYPE)) return null
  return {
    id: row.id,
    exercise: text(row, FIELD.exercise) ?? '',
    definitionId: text(row, FIELD.definition),
    occurrence: num(row, FIELD.occurrence),
  }
}
