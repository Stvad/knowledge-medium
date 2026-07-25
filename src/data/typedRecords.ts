/**
 * One call per record block.
 *
 * The grain this app rewards is *granular*: a thing worth seeing, linking,
 * undoing or syncing on its own is its own block with typed properties. But
 * writing one that way has meant `tx.run(createChild, …)`, then a
 * `setProperty` per field, then an `addTypeInTx` per type — three concepts
 * and a dozen lines per record, against one line for stuffing the same data
 * into a JSON property. Authors follow the cheaper path, and the app ends up
 * with records it can't query, reference, or hand-edit.
 *
 * `createTypedChild` closes that gap: create + type-tag + typed properties,
 * in the caller's transaction, as one statement. It is a composition of the
 * existing primitives, not a new write path — the same mutator, the same
 * codec-aware batch write, the same type tagger — so anything true of a
 * hand-rolled record stays true here.
 */

import { v5 as uuidv5 } from 'uuid'
import type { AnyPropertyAssignment, BlockData, BlockReference, Tx, TypeRegistrySnapshot } from './api'
import { createChild } from './mutators'
import type { Repo } from './repo'

export interface TypedChildSpec {
  parentId: string
  /** The block's text. Keep it human-readable: a record whose content reads
   *  like a sentence stays meaningful in the outline (and after the
   *  extension that wrote it is gone). */
  content?: string
  /** Types to tag, in order. The first is normally the record's own type;
   *  extras compose it with built-ins — `[SET_TYPE, TODO_TYPE]` makes a
   *  record that is also a todo, rendering as a checkbox and answering todo
   *  queries, instead of re-inventing done-ness. */
  types: readonly string[]
  /** Typed property values, built with `propertyValue(schema, value)` so each
   *  entry is checked against its own schema. Written as ONE codec-aware
   *  delta, so no key a peer synced in gets clobbered. */
  properties?: readonly AnyPropertyAssignment[]
  /** Where among the parent's children. Default 'last'. */
  position?:
    | { kind: 'first' }
    | { kind: 'last' }
    | { kind: 'after'; siblingId: string }
    | { kind: 'before'; siblingId: string }
  /** Explicit id, for deterministic-id callers (`pluginBlockId(...)`) that
   *  need the same input to land on the same block across re-installs. */
  id?: string
  references?: readonly BlockReference[]
  /** Reuse one registry snapshot across a batch of records. Optional — the
   *  type tagger takes its own when this is absent; passing one just avoids
   *  re-snapshotting per record in a loop. */
  typeSnapshot?: TypeRegistrySnapshot
}

/**
 * Create one typed record block under `parentId` and return its id.
 *
 * Runs inside the caller's `repo.tx`, so a batch of records lands (and
 * undoes) atomically:
 *
 * ```ts
 * await repo.tx(async tx => {
 *   const snapshot = repo.snapshotTypeRegistries()
 *   for (const set of sets) {
 *     await createTypedChild(repo, tx, {
 *       parentId: exerciseId,
 *       content: `${set.weight}lb × ${set.reps}`,
 *       types: [SET_TYPE, TODO_TYPE],
 *       properties: [propertyValue(weightProp, set.weight), propertyValue(repsProp, set.reps)],
 *       typeSnapshot: snapshot,
 *     })
 *   }
 * }, {scope: ChangeScope.BlockDefault, description: 'Log sets'})
 * ```
 */
export const createTypedChild = async (
  repo: Repo,
  tx: Tx,
  spec: TypedChildSpec,
): Promise<string> => {
  const id = await tx.run(createChild, {
    parentId: spec.parentId,
    content: spec.content ?? '',
    ...(spec.id !== undefined ? {id: spec.id} : {}),
    ...(spec.position !== undefined ? {position: spec.position} : {}),
    ...(spec.references !== undefined ? {references: [...spec.references]} : {}),
  })

  // Types first: a property whose schema the type contributes should find
  // the block already tagged, and the batch write below then lands against
  // the final type set rather than racing it.
  for (const typeId of spec.types) {
    await repo.addTypeInTx(tx, id, typeId, {}, spec.typeSnapshot)
  }

  if (spec.properties && spec.properties.length > 0) {
    await tx.setProperties(id, {set: spec.properties})
  }

  return id
}

/**
 * A record whose block id is derived from what it IS, rather than minted at
 * random.
 *
 * `namespace` is a uuid-v5 namespace, one per record kind — generate a fresh
 * random uuid for it and hard-code it. `key` is the record's natural
 * identity: everything that makes it *this* record and not another one
 * ("<workspaceId>|2026-07-24|A"). Include the workspace unless the parent
 * already scopes it.
 */
export interface DerivedIdentity {
  namespace: string
  key: string
}

/** The block id a `DerivedIdentity` resolves to. `slot` > 0 addresses the
 *  fallbacks `getOrCreateTypedChild` probes when earlier ones are taken. */
export const derivedBlockId = (identity: DerivedIdentity, slot = 0): string =>
  uuidv5(slot === 0 ? identity.key : `${identity.key}#${slot}`, identity.namespace)

export type DerivedChildOutcome =
  /** Nothing was there; the record was written from `spec`. */
  | { status: 'created'; id: string }
  /** A usable block was already at this identity. Its content and properties
   *  were NOT touched — only missing types were re-tagged. */
  | { status: 'adopted'; id: string; block: BlockData }

export interface DerivedChildSpec extends Omit<TypedChildSpec, 'id'> {
  identity: DerivedIdentity
  /** May this existing block serve as the record? Soft-deleted blocks are
   *  never offered (a deleted record was deleted on purpose, and silently
   *  resurrecting it is worse than making a new one). Default: any live
   *  block is adoptable. Return false and the next slot is probed. */
  adoptable?: (block: BlockData) => boolean
  /** How many slots to probe before giving up. Each rejected slot is a real
   *  record that already occupies this identity — a discarded workout, or a
   *  second session on the same evening — so the default is generous enough
   *  to never be hit in practice and low enough to fail loudly if a caller's
   *  `adoptable` rejects everything. */
  maxSlots?: number
}

/**
 * Get-or-create a record at a derived identity, inside the caller's tx.
 *
 * Reach for this whenever a record has a natural identity and something
 * other than you controls when the create fires — a UI gesture, a sync
 * callback, a bootstrap that runs on every launch. The alternative shape,
 * "query for it, then create if absent", cannot be made correct: the query
 * answers for the moment it ran, and two clients (or one client twice) both
 * read absent and both create. A derived id sidesteps the race instead of
 * narrowing it — both writers produce the SAME block id, so they converge on
 * one row at sync instead of leaving a duplicate nobody can reach.
 *
 * ```ts
 * await repo.tx(async tx => {
 *   const outcome = await getOrCreateTypedChild(repo, tx, {
 *     identity: {namespace: WORKOUT_NS, key: `${workspaceId}|${day}|${session}`},
 *     parentId: pageId,
 *     content: `Session ${session} · ${day}`,
 *     types: [WORKOUT_TYPE],
 *     properties: [propertyValue(statusProp, 'in-progress')],
 *     // A finished workout is not this evening's log — take the next slot.
 *     adoptable: block => block.properties[statusProp.name] !== 'done',
 *   })
 *   if (outcome.status === 'created') …
 * })
 * ```
 *
 * Free for a NEW record kind, and a migration for an existing one: records
 * already written with random ids are invisible to a derived lookup, so
 * switching a live kind over creates a second row beside every one of them.
 * Convert only alongside a plan for what happens to the rows already out
 * there — or leave the old kind on its hand-rolled lookup and use this for
 * the next one.
 *
 * On adopt, `content` and `properties` are deliberately NOT applied: the
 * block on disk holds real state, and overwriting it with the defaults this
 * caller happens to hold is the data loss the whole primitive exists to
 * avoid. Callers wanting upsert semantics write their properties after the
 * call, where the intent is explicit. Missing `types` ARE re-tagged, so a
 * record that lost a type tag repairs itself.
 */
export const getOrCreateTypedChild = async (
  repo: Repo,
  tx: Tx,
  spec: DerivedChildSpec,
): Promise<DerivedChildOutcome> => {
  const {identity, adoptable, maxSlots: slotLimit, ...childSpec} = spec
  const maxSlots = slotLimit ?? 16
  for (let slot = 0; slot < maxSlots; slot += 1) {
    const id = derivedBlockId(identity, slot)
    const existing = await tx.get(id)

    if (existing && !existing.deleted && (adoptable?.(existing) ?? true)) {
      for (const typeId of childSpec.types) {
        await repo.addTypeInTx(tx, id, typeId, {}, childSpec.typeSnapshot)
      }
      return {status: 'adopted', id, block: existing}
    }
    if (existing) continue // taken by a tombstone or a record this caller rejected

    await createTypedChild(repo, tx, {...childSpec, id})
    return {status: 'created', id}
  }
  throw new Error(
    `getOrCreateTypedChild: all ${maxSlots} slots for "${identity.key}" are taken. ` +
    'Either the identity key is not specific enough, or `adoptable` rejects everything.',
  )
}
