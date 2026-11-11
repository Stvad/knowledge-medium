/**
 * Field-level undo/redo: which state an undo or redo drives a row to.
 *
 * An undo entry holds one tx's `(before, after)` per row. Replaying it
 * restores only the parts of the row that tx CHANGED, onto the row as it is
 * now — so a write that never entered this undo stack (an automation write,
 * another device's synced edit) survives an undo of an unrelated part of the
 * same row. Restoring the whole snapshot would silently revert those writes.
 *
 * The parts, each restored as a unit:
 *  - content, with what is derived from it: `referenceTargetId`,
 *    `isFieldForm` and the content references (no `sourceField`);
 *  - position: `parentId` + `orderKey`;
 *  - `deleted`;
 *  - each property key, with the references projected from it
 *    (`sourceField` = that key).
 *
 * Within a part the far side wins outright: a part the entry changed is put
 * back even if something else changed it since, as whole-row replay did.
 */
import { isEqual } from 'lodash-es'
import { normalizeReferences, type BlockData, type BlockReference } from '@/data/api'

const contentRefs = (row: BlockData): BlockReference[] =>
  row.references.filter(ref => !ref.sourceField)

const fieldRefs = (row: BlockData, key: string): BlockReference[] =>
  row.references.filter(ref => ref.sourceField === key)

/** `isFieldForm` is pure syntax of the content, so it never changes alone; a
 *  reference's resolution can (its target appearing later). */
const contentPartChanged = (a: BlockData, b: BlockData): boolean =>
  a.content !== b.content
  || (a.referenceTargetId ?? null) !== (b.referenceTargetId ?? null)
  || !isEqual(contentRefs(a), contentRefs(b))

const propertyKeyChanged = (a: BlockData, b: BlockData, key: string): boolean =>
  !isEqual(a.properties[key], b.properties[key])
  || !isEqual(fieldRefs(a, key), fieldRefs(b, key))

const propertyKeysOf = (a: BlockData, b: BlockData): Set<string> =>
  new Set([...Object.keys(a.properties), ...Object.keys(b.properties)])

/** Whether any part of the row differs between `a` and `b`. */
const anyPartChanged = (a: BlockData, b: BlockData): boolean =>
  contentPartChanged(a, b)
  || a.parentId !== b.parentId || a.orderKey !== b.orderKey
  || a.deleted !== b.deleted
  || [...propertyKeysOf(a, b)].some(key => propertyKeyChanged(a, b, key))

/** The row state replaying one entry's side `to` should leave, given the row
 *  as it is now (`current`) and the entry's other side (`from`). Engine
 *  metadata (`updatedAt`, `updatedBy`, …) is the caller's to stamp. */
export const replayTarget = (current: BlockData, from: BlockData | null, to: BlockData): BlockData => {
  // The entry created the row (redo of a create): nothing of it predates the
  // entry, so every part is the entry's.
  if (from === null) return to
  // Nothing has touched the row since the entry left it: restore the far side
  // exactly, property key order included.
  if (!anyPartChanged(current, from)) return to

  const merged: BlockData = {...current, properties: {...current.properties}}

  const contentChanged = contentPartChanged(from, to)
  if (contentChanged) {
    merged.content = to.content
    merged.referenceTargetId = to.referenceTargetId ?? null
    merged.isFieldForm = to.isFieldForm
  }
  if (from.parentId !== to.parentId || from.orderKey !== to.orderKey) {
    merged.parentId = to.parentId
    merged.orderKey = to.orderKey
  }
  if (from.deleted !== to.deleted) merged.deleted = to.deleted

  const restoredKeys = new Set<string>()
  for (const key of propertyKeysOf(from, to)) {
    if (!propertyKeyChanged(from, to, key)) continue
    restoredKeys.add(key)
    if (key in to.properties) merged.properties[key] = to.properties[key]
    else delete merged.properties[key]
  }

  // Canonical order, as every stored row holds it: replay skips the
  // processors that would normalize it, and a receiving client rejects
  // non-canonical references.
  merged.references = normalizeReferences([
    ...(contentChanged ? contentRefs(to) : contentRefs(current)),
    ...current.references.filter(ref => ref.sourceField && !restoredKeys.has(ref.sourceField)),
    ...to.references.filter(ref => ref.sourceField && restoredKeys.has(ref.sourceField)),
  ])
  return merged
}
