/**
 * Field-level undo/redo: which state an undo or redo drives a row to.
 *
 * An undo entry holds one tx's `(before, after)` per row. Replaying it
 * restores only the parts of each row that tx CHANGED, onto the row as it is
 * now — so a write that never entered this undo stack (a background agent's
 * bookkeeping, another device's synced edit) survives an undo of an unrelated
 * part of the same row.
 *
 * Only when no part was written both by the entry and since
 * ({@link replayConflicts}). Parts an invariant couples — a page's title and
 * its aliases, a property's cell and its field/value rows — are written in one
 * tx by the processor that keeps them in sync, and replay skips processors, so
 * merging one without the other would split them. A write since that touched
 * either side of such a pair overlaps the entry there; such an entry restores
 * its far side whole instead, consistent and over the later write.
 */
import { isEqual } from 'lodash-es'
import { normalizeReferences, type BlockData, type BlockReference } from '@/data/api'
import { storedPropertyValue } from '@/data/rowProperty'
import { jsonValuesEqual } from './jsonCanonical'

/** What differs between two states of one row, part by part. */
interface ChangedParts {
  /** Content, with what is derived from it: `referenceTargetId`,
   *  `isFieldForm` (pure syntax of the content) and the references with no
   *  `sourceField`. */
  content: boolean
  /** `parentId` + `orderKey`. */
  position: boolean
  deleted: boolean
  /** Property keys whose value, or whose projected references
   *  (`sourceField` = the key), differ. */
  keys: Set<string>
}

const contentRefs = (row: BlockData): BlockReference[] =>
  row.references.filter(ref => !ref.sourceField)

const fieldRefs = (row: BlockData, key: string): BlockReference[] =>
  row.references.filter(ref => ref.sourceField === key)

const changedParts = (a: BlockData, b: BlockData): ChangedParts => ({
  content: a.content !== b.content
    || (a.referenceTargetId ?? null) !== (b.referenceTargetId ?? null)
    || !isEqual(contentRefs(a), contentRefs(b)),
  position: a.parentId !== b.parentId || a.orderKey !== b.orderKey,
  deleted: a.deleted !== b.deleted,
  keys: new Set([...Object.keys(a.properties), ...Object.keys(b.properties)].filter(key =>
    !jsonValuesEqual(storedPropertyValue(a.properties, key), storedPropertyValue(b.properties, key))
    || !isEqual(fieldRefs(a, key), fieldRefs(b, key)))),
})

const noneChanged = (parts: ChangedParts): boolean =>
  !parts.content && !parts.position && !parts.deleted && parts.keys.size === 0

const overlap = (a: ChangedParts, b: ChangedParts): boolean =>
  (a.content && b.content) || (a.position && b.position) || (a.deleted && b.deleted)
  || [...a.keys].some(key => b.keys.has(key))

/** The state the entry left the row in, seen from `to`'s side. A created
 *  row's undo only tombstones it, so its redo starts from that tombstone. */
const entrySide = (from: BlockData | null, to: BlockData): BlockData => from ?? {...to, deleted: true}

/** Whether a write since the entry left the row (`current`) touched a part
 *  the entry changed between `from` and `to`. */
export const replayConflicts = (current: BlockData, from: BlockData | null, to: BlockData): boolean => {
  const side = entrySide(from, to)
  return overlap(changedParts(side, current), changedParts(side, to))
}

/** The row state replaying one entry's side `to` should leave, given the row
 *  as it is now (`current`) and the entry's other side (`from`). Only for an
 *  entry with no {@link replayConflicts}. Engine metadata (`updatedAt`,
 *  `updatedBy`, …) is the caller's to stamp. */
export const replayTarget = (current: BlockData, from: BlockData | null, to: BlockData): BlockData => {
  const side = entrySide(from, to)
  // Nothing has touched the row since the entry left it: restore the far side
  // exactly, property key order included.
  if (noneChanged(changedParts(side, current))) return to

  const changed = changedParts(side, to)
  const merged: BlockData = {...current, properties: {...current.properties}}
  if (changed.content) {
    merged.content = to.content
    merged.referenceTargetId = to.referenceTargetId ?? null
    merged.isFieldForm = to.isFieldForm
  }
  if (changed.position) {
    merged.parentId = to.parentId
    merged.orderKey = to.orderKey
  }
  if (changed.deleted) merged.deleted = to.deleted
  for (const key of changed.keys) {
    if (Object.hasOwn(to.properties, key)) merged.properties[key] = to.properties[key]
    else delete merged.properties[key]
  }

  // Canonical order, as every stored row holds it: replay skips the
  // processors that would normalize it, and a receiving client rejects
  // non-canonical references.
  merged.references = normalizeReferences([
    ...(changed.content ? contentRefs(to) : contentRefs(current)),
    ...current.references.filter(ref => ref.sourceField && !changed.keys.has(ref.sourceField)),
    ...to.references.filter(ref => ref.sourceField && changed.keys.has(ref.sourceField)),
  ])
  return merged
}
