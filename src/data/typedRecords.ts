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

import type { AnyPropertyAssignment, BlockReference, Tx, TypeRegistrySnapshot } from './api'
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
