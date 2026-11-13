/**
 * THE minting owner for property machinery: every field row and value child
 * the app creates gets its id here.
 *
 * An id is derived from what the row IS ({@link PropertyChildSlot}), so two
 * devices that set one property on one block before either has seen the other
 * write the same rows, and sync folds them by id. Minting stays lookup-first:
 * callers reuse a live row they find, under whatever id it has (most existing
 * rows are random-id), and come here only when they found none.
 *
 * What sits at the derived id decides the rest:
 *  - nothing → the row is created there;
 *  - a tombstone under the same parent → the live writer RESTORES it, which
 *    is what re-setting a removed property is, and moves it to the planned
 *    order key (a list member re-added at the end). Two writers leave it dead
 *    and take a random id: the create-only backfill (a tombstone is a delete
 *    it must not undo) and a write under revival, which declines ambiguous
 *    tombstones on purpose;
 *  - a tombstone moved elsewhere before it died → a random id: its parent may
 *    be dead too, and restoring a row under a dead parent aborts the write;
 *  - a live row → it is no longer this slot's row (a field row moved out from
 *    under its owner, a member edited in place to another value), so the new
 *    row takes a random id. ACCEPTED: that row converges with nothing, exactly
 *    as every row did before ids were derived.
 *
 * The namespace is keyed by `K_id` in a sealed workspace
 * (`@/data/workspaceIdNamespace`): `reference_target_id` does not sync, but
 * block ids do, in plaintext, and a public namespace would let the server hash
 * owner ids it sees with seed definition ids it knows and learn which blocks
 * carry which property. A sealed workspace whose namespace was not resolved
 * before the write lock mints a RANDOM id — never one under the public
 * namespace — so the property write still lands and only convergence is lost.
 */

import type { NewBlockData, Tx } from '@/data/api'
import type { Repo } from '@/data/repo'
import { classifyOccupant, propertyChildBlockId, type PropertyChildSlot } from '@/data/derivedIds'
import {
  DerivedIdNamespaceUnavailableError,
  derivedIdNamespaceInTx,
  resolveDerivedIdNamespace,
  type DerivedIdNamespaceKind,
} from '@/data/workspaceIdNamespace'

const PROPERTY_CHILD_NAMESPACE: DerivedIdNamespaceKind = {
  label: 'km/property-child-ns/v1',
  plaintextNamespace: '4ddc11ad-ce83-4be7-813e-660f882e676d',
}

/** PRE-LOCK: resolve and cache `workspaceId`'s property-child namespace, so
 *  the in-lock mint can derive. Throws `WorkspaceKeyUnavailableError` for a
 *  sealed workspace this device holds no key for. */
export const resolvePropertyChildNamespace = (repo: Repo, workspaceId: string): Promise<string> =>
  resolveDerivedIdNamespace(repo, workspaceId, PROPERTY_CHILD_NAMESPACE)

/** IN-LOCK: the namespace to derive under, or `null` when the workspace is
 *  sealed and its namespace was not resolved first — mint a random id then. */
export const propertyChildNamespaceInTx = async (tx: Tx, workspaceId: string): Promise<string | null> => {
  try {
    return await derivedIdNamespaceInTx(tx, tx.meta.user.id, workspaceId, PROPERTY_CHILD_NAMESPACE)
  } catch (err) {
    if (err instanceof DerivedIdNamespaceUnavailableError) return null
    throw err
  }
}

/** A planned machinery row and the slot it fills. */
export interface PlannedPropertyChild {
  row: NewBlockData & {parentId: string}
  slot: PropertyChildSlot
}

/** What a mint does with a tombstone at its derived id: bring it back, or
 *  leave it dead and take a random id. */
export type OnTombstone = 'restore' | 'leave'

/** Create `row` at its slot's derived id; see the module header for what is
 *  done when something already sits there. Returns the id the row has. */
export const mintPropertyChildRow = async (
  tx: Tx,
  {row, slot}: PlannedPropertyChild,
  onTombstone: OnTombstone,
): Promise<string> => {
  const namespace = await propertyChildNamespaceInTx(tx, row.workspaceId)
  if (namespace === null) return tx.create(row)
  const id = propertyChildBlockId(namespace, row.workspaceId, slot)
  const occupancy = classifyOccupant(await tx.get(id), {workspaceId: row.workspaceId})
  if (occupancy.verdict === 'absent') return tx.create({...row, id})
  const restorable = occupancy.verdict === 'tombstoned' && onTombstone === 'restore'
    && occupancy.block.parentId === row.parentId
  if (!restorable) return tx.create(row)

  // The tombstone keeps its own property bag: a value row can own properties
  // too, and what it held is the user's.
  await tx.restore(id, {
    content: row.content ?? '',
    ...(row.references !== undefined ? {references: row.references} : {}),
    ...(row.referenceTargetId !== undefined ? {referenceTargetId: row.referenceTargetId} : {}),
    ...(row.isFieldForm !== undefined ? {isFieldForm: row.isFieldForm} : {}),
  })
  if (occupancy.block.orderKey !== row.orderKey) {
    await tx.move(id, {parentId: row.parentId, orderKey: row.orderKey})
  }
  return id
}

/** The bulk, CREATE-ONLY form, for a pass that writes through `tx.createMany`:
 *  each row at its derived id when nothing at all sits there, else with no id
 *  (a random one). Never restores — see the module header. */
export const withPropertyChildIds = async (
  tx: Tx,
  workspaceId: string,
  planned: readonly PlannedPropertyChild[],
): Promise<NewBlockData[]> => {
  if (planned.length === 0) return []
  const namespace = await propertyChildNamespaceInTx(tx, workspaceId)
  if (namespace === null) return planned.map(({row}) => row)
  const ids = planned.map(({row, slot}) => propertyChildBlockId(namespace, row.workspaceId, slot))
  // Grows as ids are handed out, so two planned rows of one batch that derive
  // the same id cannot both claim it.
  const taken = await tx.existingIds(ids)
  return planned.map(({row}, index) => {
    const id = ids[index]!
    if (taken.has(id)) return row
    taken.add(id)
    return {...row, id}
  })
}
