/**
 * THE minting owner for property machinery: every field row and value child
 * the app creates gets its id here.
 *
 * A row is minted at an id DERIVED from what it is ({@link PropertyChildSlot})
 * only when its PARENT was created in this same transaction. Two devices that
 * create one block at a deterministic id with its properties (an ingested chat
 * message) then write the same machinery rows, and sync folds them by id.
 *
 * Why only then: a row at that id on another device sits under the same parent
 * id, so that device created the same parent too, and the parent's create
 * collides with it. Under a block that already existed here, a derived id can
 * instead meet a tombstone a peer left (it set and then removed the property)
 * that this device has not received; the server keeps the first create of an
 * id, so the write would leave the children while its cell patch landed.
 * Every other mint takes a random id, so two offline first writes on an
 * existing block still make two field rows (`collapseDuplicateFieldRow` folds
 * them at the next local write).
 *
 * What converges is only what COLLIDES: a slot both devices filled resolves to
 * the first create, alongside the parent's. A slot only one device filled — a
 * member or a property the other did not have — lands on its own, as a
 * random-id row would, under the server's block, whose cell is the FIRST
 * create's; the next edit of that value in the tree projects it into the cell,
 * and the next write of the property reaps it. A later edit of a row that turns
 * out to be a peer's tombstone follows the ordinary delete-vs-edit rule: the
 * delete holds in the children while the cell takes the edit, exactly as for
 * any row two devices share.
 *
 * A row already at the derived id (this transaction removed the property and
 * set it again) means a random id. ACCEPTED: that row converges with nothing.
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
import { propertyChildBlockId, type PropertyChildSlot } from '@/data/derivedIds'
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
export const propertyChildNamespaceInTx = async (
  tx: Tx,
  workspaceId: string,
): Promise<string | null> => {
  try {
    return await derivedIdNamespaceInTx(tx, tx.meta.user.id, workspaceId, PROPERTY_CHILD_NAMESPACE)
  } catch (err) {
    if (err instanceof DerivedIdNamespaceUnavailableError) return null
    throw err
  }
}

/** Create one machinery row under `row.parentId`, at `slot`'s derived id when
 *  the module header allows it, else at a random one. Returns its id. */
export const mintPropertyChildRow = async (
  tx: Tx,
  row: NewBlockData & {parentId: string},
  slot: PropertyChildSlot,
): Promise<string> => {
  if (!tx.createdInThisTx(row.parentId)) return tx.create(row)
  const namespace = await propertyChildNamespaceInTx(tx, row.workspaceId)
  if (namespace === null) return tx.create(row)
  const id = propertyChildBlockId(namespace, row.workspaceId, row.parentId, slot)
  if (await tx.get(id) !== null) return tx.create(row)
  return tx.create({...row, id})
}
