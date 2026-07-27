/** Pure block → record readers.
 *
 *  These take the raw rows a typed-block query returns and assemble the
 *  engine's `WorkoutRecord` / `LayoffRecord` shapes. They import only field
 *  names and plain helpers — no runtime `@/` module — so the mapping is
 *  unit-testable in a plain node environment.
 *
 *  Property values on a row are codec-*encoded*: dates are ISO strings,
 *  everything the extension stores otherwise round-trips as identity JSON
 *  (numbers, strings, the sets array). So the only decode needed here is
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
 *  Only DONE workouts count as history (an in-progress session is the live
 *  logging state and must never feed its own prescription), and within a
 *  workout only DONE sets are counted (a pre-filled, un-accepted set records
 *  nothing). */
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
    workouts.push({
      id: row.id,
      date: d.toISOString(),
      session,
      ...(recordedAt !== undefined ? {recordedAt} : {}),
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

// ──── live in-progress workouts (for the logging UI) ────
// Distinct from buildHistory: keeps EVERY set (done and not) with its block id
// so the UI can edit sets in place, and only surfaces in-progress workouts.

export interface LiveSet {
  id: string
  weight: number
  reps: number
  rpe?: number
  side?: 'L' | 'R'
  done: boolean
  completedAt?: number
  /** Which set of the lift this is, as the BLOCK states it — absent on sets
   *  written before the property existed, where the caller falls back to
   *  position among the siblings. */
  index?: number
}

export interface LiveExercise {
  id: string
  exercise: string
  /** Plan block it was logged from — how the draft re-attaches to the right
   *  prescription even if the exercise has since been renamed. */
  definitionId?: string
  unit: string
  prescribedWeight?: number
  prescribedSets?: number
  /** Which time in its session this lift is, as the BLOCK states it — see
   *  `LiftEntry`. Absent on entries written before the property existed. */
  occurrence?: number
  sets: LiveSet[]
}

export interface LiveWorkout {
  id: string
  day: string
  session: SessionType
  exercises: LiveExercise[]
}

/** Exported because the WRITE side needs it too: a set write is a patch
 *  merged over what the block currently holds, and this is the one decoder
 *  that says what "currently holds" means. */
export const toLiveSet = (row: RowLike): LiveSet => ({
  id: row.id,
  weight: num(row, FIELD.weight, 0),
  reps: num(row, FIELD.reps, 0),
  ...(optNum(row, FIELD.rpe) !== undefined ? {rpe: optNum(row, FIELD.rpe)} : {}),
  ...(side(row, FIELD.side) !== undefined ? {side: side(row, FIELD.side)} : {}),
  done: isDone(row),
  ...(optNum(row, FIELD.completedAt) !== undefined ? {completedAt: optNum(row, FIELD.completedAt)} : {}),
  ...(optNum(row, FIELD.setIndex) !== undefined ? {index: optNum(row, FIELD.setIndex)} : {}),
})

/** What identifies a lift WITHIN one workout: its plan block if it has one
 *  (so a rename mid-session changes nothing), else its name — plus which
 *  occurrence of that lift this is, because a session can prescribe the same
 *  lift twice and the two rows must not share an entry.
 *
 *  The one definition of "the same lift", used by all three sides that have to
 *  agree about it: the write path derives an entry's block id from exactly
 *  these (`exerciseIdentity` in store.ts), the draft stamps it on every row
 *  (`rowKey` in draft.ts), and the matcher below re-attaches the draft to the
 *  blocks. When they disagreed, the draft edited blocks the writer had
 *  assigned to a different row. */
export const liftKey = (
  definitionId: string | undefined,
  exercise: string,
  occurrence: number,
): string => `${escapeKeyPart(definitionId ?? exercise)}|${occurrence}`

/** `|` separates the parts of every identity string here, so a lift whose
 *  NAME contains one could spell another row's identity: "Bench|1" at
 *  occurrence 0 and "Bench" at occurrence 1 both read as `Bench|1`, and two
 *  rows the matcher treats as different lifts would share one entry block —
 *  and, positionally, one set block per index. Escaping makes the parts
 *  recoverable, so the separator can only ever be the separator.
 *
 *  Exported because the WRITE side spells the same identity into a derived
 *  block id and has to escape it identically. */
export const escapeKeyPart = (part: string): string => part.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')

/** One lift, as either side names it. The draft calls its plan block `defId`;
 *  a logged entry calls it `definitionId`. */
export interface LiftRef {
  definitionId?: string
  exercise: string
  occurrence: number
}

/** All the matcher reads off a logged entry. Narrower than `LiveExercise` so
 *  the WRITE path can match too, without inventing the fields it doesn't have
 *  (a `unit`, a set list) purely to satisfy a type. */
export interface LiftEntry {
  id: string
  exercise: string
  definitionId?: string
  /** Which time in its session this lift is, as the BLOCK states it. Absent on
   *  entries written before the property existed, where block order is the
   *  best guess available. */
  occurrence?: number
}

/** Which live entry backs each draft row, keyed on `liftKey`.
 *
 *  Each live entry states which occurrence it is (`occurrencesOf`), so a lift
 *  prescribed twice in one session keeps its rows attached to the right blocks
 *  however the entries are ordered. Entries written before that property
 *  existed still fall back to block order — a deterministic total order
 *  (`compareByOrderKey` breaks ties on id), so stable against sync arrival
 *  order, but not against hand-reordering.
 *
 *  A row matches its plan block first, then falls back to the lift's NAME —
 *  because whether either side knows a lift's plan block is a property of WHEN
 *  it was written, not of which lift it is. `configLoaded` goes true even when
 *  the plan read FAILS (deliberately: blocking logging on an unreadable
 *  outline is worse than logging against the built-in names), so the mismatch
 *  arises for the same mundane reason in both directions:
 *
 *   - the entry has no plan block and the row does — logged while the outline
 *     was unreadable, and then it resolved;
 *   - the row has no plan block and the entry does — the outline is unreadable
 *     HERE, and the session was started somewhere it wasn't.
 *
 *  Either way, refusing to match orphans a live session. The sets are safe,
 *  since Finish reads the committed tree, but the view shows a pristine
 *  pre-filled session over real logged work, and the obvious response is to
 *  log it again — which builds a second entry tree beside the first.
 *
 *  The fallback is safe because a matched row's writes FOLLOW the match: a set
 *  that has a block writes to that block, and one that doesn't goes through the
 *  entry the row is attached to (`writeExercise`'s `entryId`) instead of
 *  re-deriving. The one restriction left is that a row WITH a plan block never
 *  falls back onto an entry carrying a DIFFERENT one — those are two genuinely
 *  different lifts that happen to share a name. */
/** Which occurrence each live entry is — what it SAYS it is, falling back to
 *  its position among the entries for the same lift.
 *
 *  The block says so because position is not identity: a session can prescribe
 *  one lift twice, and dragging the two entries past each other in the outline
 *  used to swap which prescription row each backed — so the rows displayed,
 *  and then wrote, each other's weights and ticks.
 *
 *  A duplicated claim is no claim: if two entries for one lift both say
 *  occurrence 1, neither number can be believed and both fall back to order —
 *  the same rule the set overlay uses for a duplicated index, and for the same
 *  reason (believing the first would move it AND displace the second).
 *  Fallbacks fill the numbers a believed claim hasn't taken. */
const occurrencesOf = <T extends LiftEntry>(entries: readonly T[]): Map<T, number> => {
  const baseOf = (entry: T): string => entry.definitionId ?? entry.exercise
  const stated = (entry: T): number | undefined =>
    entry.occurrence !== undefined
      && Number.isSafeInteger(entry.occurrence) && entry.occurrence >= 0
      ? entry.occurrence
      : undefined

  const claims = new Map<string, number>()
  for (const entry of entries) {
    const occurrence = stated(entry)
    if (occurrence !== undefined) {
      const key = `${baseOf(entry)}\u0000${occurrence}`
      claims.set(key, (claims.get(key) ?? 0) + 1)
    }
  }

  const believed = new Map<T, number>()
  const taken = new Map<string, Set<number>>()
  for (const entry of entries) {
    const occurrence = stated(entry)
    if (occurrence === undefined) continue
    if (claims.get(`${baseOf(entry)}\u0000${occurrence}`) !== 1) continue
    believed.set(entry, occurrence)
    const base = baseOf(entry)
    taken.set(base, (taken.get(base) ?? new Set()).add(occurrence))
  }

  const nextFree = new Map<string, number>()
  const result = new Map<T, number>()
  for (const entry of entries) {
    const base = baseOf(entry)
    const claimed = believed.get(entry)
    if (claimed !== undefined) {
      result.set(entry, claimed)
      continue
    }
    let occurrence = nextFree.get(base) ?? 0
    while (taken.get(base)?.has(occurrence)) occurrence += 1
    nextFree.set(base, occurrence + 1)
    taken.set(base, (taken.get(base) ?? new Set()).add(occurrence))
    result.set(entry, occurrence)
  }
  return result
}

export const matchLiveExercises = <T extends LiftEntry>(
  rows: readonly LiftRef[],
  entries: readonly T[] | undefined,
): (T | undefined)[] => {
  if (!entries) return rows.map(() => undefined)
  const live = {exercises: entries}

  const byKey = new Map<string, T>()
  /** Entries queued by name, in block order. A QUEUE rather than an
   *  occurrence-keyed map, because the two sides count occurrences over
   *  different things: a row counts within `defId ?? name`, an unplanned entry
   *  only has its name. Two plan blocks sharing a display name, logged while
   *  the outline was unreadable, gave both rows occurrence 0 — so both asked
   *  for the same entry, the second was refused, and its next edit split the
   *  log. Taking the next unclaimed one with that name has no such assumption.
   */
  const byName = new Map<string, T[]>()
  for (const [entry, occurrence] of occurrencesOf(live.exercises)) {
    byKey.set(liftKey(entry.definitionId, entry.exercise, occurrence), entry)
    byName.set(entry.exercise, [...(byName.get(entry.exercise) ?? []), entry])
  }

  // Claimed-once: with two ways to match, one entry could otherwise back two
  // rows, which then write over each other set for set.
  const claimed = new Set<string>()
  const nextByName = (row: LiftRef): T | undefined =>
    (byName.get(row.exercise) ?? []).find(entry =>
      !claimed.has(entry.id)
      // A row that HAS a plan block never falls back onto an entry carrying a
      // different one — those are two genuinely different lifts that happen to
      // share a name. A row without one is free to take either.
      && (row.definitionId === undefined || entry.definitionId === undefined))

  // TWO passes, exact first. A name-only row earlier in the list would
  // otherwise fall back onto the very entry that a later row matches on its
  // plan block — the later row then reads as unlogged even though an entry
  // was free for the earlier one, and its next write attaches both rows to
  // one derived entry.
  const matched: (T | undefined)[] = rows.map(() => undefined)
  rows.forEach((row, i) => {
    const exact = byKey.get(liftKey(row.definitionId, row.exercise, row.occurrence))
    if (!exact || claimed.has(exact.id)) return
    claimed.add(exact.id)
    matched[i] = exact
  })
  rows.forEach((row, i) => {
    if (matched[i] !== undefined) return
    const fallback = nextByName(row)
    if (!fallback) return
    claimed.add(fallback.id)
    matched[i] = fallback
  })
  return matched
}

export const buildLiveWorkouts = (
  workoutRows: readonly RowLike[],
  exerciseRows: readonly RowLike[],
  setRows: readonly RowLike[],
): LiveWorkout[] => {
  const exercisesByWorkout = groupByParent(exerciseRows)
  const setsByExercise = groupByParent(setRows)

  const live: LiveWorkout[] = []
  for (const row of workoutRows) {
    if (str(row, FIELD.status) !== 'in-progress') continue
    const d = date(row, FIELD.date)
    if (d === undefined) continue
    const entries = (exercisesByWorkout.get(row.id) ?? []).slice().sort(compareByOrderKey)
    live.push({
      id: row.id,
      day: dateToDay(d),
      session: str(row, FIELD.session, 'A') as SessionType,
      exercises: entries.map(entry => ({
        id: entry.id,
        exercise: str(entry, FIELD.exercise),
        definitionId: optStr(entry, FIELD.definition),
        unit: str(entry, FIELD.unit, 'lb'),
        prescribedWeight: optNum(entry, FIELD.prescribedWeight),
        prescribedSets: optNum(entry, FIELD.prescribedSets),
        occurrence: optNum(entry, FIELD.occurrence),
        sets: (setsByExercise.get(entry.id) ?? []).slice().sort(compareByOrderKey).map(toLiveSet),
      })),
    })
  }
  return live
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
      from: dateToDay(from),
      to: dateToDay(to),
      days: num(row, FIELD.layoffDays, 0),
      tierId: str(row, FIELD.layoffTier),
      pct: num(row, FIELD.layoffPct, 1),
    })
  }
  return layoffs.sort((a, b) => a.to.localeCompare(b.to))
}
