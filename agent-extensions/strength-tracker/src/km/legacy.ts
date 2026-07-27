/** Reading the shape this extension used to write.
 *
 *  The first version stored a lift's sets as ONE JSON property on the entry
 *  (`strength:sets`) rather than a block per set. That bought fewer rows and
 *  cost everything the app gives a block for free: a set could not be
 *  referenced, hand-edited, undone, or counted by SQL, and done-ness could
 *  not compose with the built-in todo. Sessions written that way are still
 *  real training history, so they get converted rather than left behind.
 *
 *  Pure, and separate from the write path, because the risky half of a
 *  migration is deciding what the old data MEANS — and that half should be
 *  testable without a database.
 */

import type {SetDraft} from './store'

/** The legacy property name. Deliberately spelled here rather than in
 *  `FIELD`: nothing writes it any more, and putting it back in the live field
 *  map would invite something to start. */
export const LEGACY_SETS_PROP = 'strength:sets'

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** One element of the legacy JSON array → a set this extension can write.
 *  `undefined` for anything that isn't recognizably a set. */
const readLegacySet = (raw: unknown): SetDraft | undefined => {
  if (typeof raw !== 'object' || raw === null) return undefined
  const {weight, reps, rpe, side, completedAt} = raw as Record<string, unknown>
  if (!isFiniteNumber(weight) || !isFiniteNumber(reps)) return undefined
  return {
    weight,
    reps,
    // Every legacy set is a performed one: the old writer only ever wrote at
    // the END of a session, so there is no such thing as a pre-filled row in
    // that data. Recording them as open todos would hide the whole of this
    // history from `buildHistory`, which counts done sets only.
    done: true,
    ...(isFiniteNumber(rpe) ? {rpe} : {}),
    ...(side === 'L' || side === 'R' ? {side} : {}),
    ...(isFiniteNumber(completedAt) ? {completedAt} : {}),
  }
}

/** The legacy `strength:sets` cell → the sets it holds.
 *
 *  `undefined` means "do not touch this entry": the cell is absent, or it is
 *  there and cannot be read as a list of sets. All-or-nothing per entry on
 *  purpose — half-converting a training record is worse than leaving it,
 *  because the half that lands looks complete to every reader.
 *
 *  Takes the RAW property bag value, which for a `json` property is the
 *  codec's encoded string; an already-decoded array is accepted too, so the
 *  same function reads a row however it was obtained. */
export const readLegacySets = (raw: unknown): SetDraft[] | undefined => {
  if (raw === undefined || raw === null) return undefined
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (!Array.isArray(parsed) || parsed.length === 0) return undefined
  const sets: SetDraft[] = []
  for (const element of parsed) {
    const set = readLegacySet(element)
    if (set === undefined) return undefined
    sets.push(set)
  }
  return sets
}
