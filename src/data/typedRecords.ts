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

import { derivedBlockId, type DerivedIdentity } from './derivedIds'
import type { AnyPropertyAssignment, BlockData, BlockReference, Tx, TypeRegistrySnapshot } from './api'
import { DeletedConflictError, DeterministicIdCrossWorkspaceError } from './api/errors'
import { createChild, orderKeyForInsert } from './mutators'
import { hasBlockType } from './properties'
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
  /** Explicit id.
   *
   *  NOT the way to write a deterministic-id record, despite the shape:
   *  this path mints an ordinary `updated_at`, and a second call with the
   *  same id throws `DuplicateIdError` rather than adopting. That is exactly
   *  the creator shape `syncObserver/reconcile.ts` names as the remaining I1
   *  gap — two devices minting one id in the same millisecond produce equal
   *  nonzero stamps from different writes, and the loser strands. Use
   *  `getOrCreateTypedChild`, which stamps 0 and adopts. */
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

/** Identity and id derivation live in `@/data/derivedIds` — shared with the
 *  kernel pages and reference seats, which derive ids the same way but apply a
 *  different policy to what they find. That module is also where the rules for
 *  choosing a namespace and a key are written down. Re-exported here so a
 *  caller of `getOrCreateTypedChild` has the type to hand.
 *
 *  For a record, `parentId` is NOT part of the derivation: a parent scopes a
 *  record only if the parent's own id is in the key, the way an exercise entry
 *  keys on its workout. */
export { derivedBlockId, type DerivedIdentity }

export type DerivedChildOutcome =
  /** Nothing was there; the record was written from `spec`. */
  | { status: 'created'; id: string }
  /** A usable block was already at this identity. Its content and properties
   *  were NOT touched — only missing types were re-tagged. */
  | { status: 'adopted'; id: string; block: BlockData }
  /** The id is occupied by something this caller cannot use: a tombstone, a
   *  row in another workspace, or a live block `adoptable` rejected. NOTHING
   *  was written — the decision is the caller's, because only the caller
   *  knows whether a second record here is meaningful.
   *
   *  Usually it is, and then the answer is a lookup followed by a MINTED id
   *  rather than another derived one: see the note on deliberate seconds in
   *  `getOrCreateTypedChild`. `block` is the occupant when one could be read
   *  (null only for a row `tx.get` would not surface). */
  | { status: 'taken'; id: string; block: BlockData | null }

export interface DerivedChildSpec extends Omit<TypedChildSpec, 'id' | 'position'> {
  identity: DerivedIdentity
  /** Where among the parent's children the CREATE puts the row. Default
   *  'last'.
   *
   *  Narrower than `createTypedChild`'s, which also takes `{before}` /
   *  `{after}`, and deliberately so: this call promises that a `taken`
   *  outcome wrote NOTHING, and an anchored position cannot keep that
   *  promise. Placement has to be computed BEFORE `tx.createOrGet`, and
   *  `createOrGet` is the only thing that can see the two occupants `tx.get`
   *  does not surface — a tombstone, and a row of the same id in another
   *  workspace. So by the time `taken` is the answer, an anchored position
   *  has already either thrown (`orderKeyForInsert` throws when the anchor
   *  is no longer a sibling — moved away, or deleted) or re-keyed a tied run
   *  of innocent siblings (`keysImmediatelyBefore`/`After` call `tx.move` to
   *  open a strict slot). `first` and `last` reduce to `keyAtStart` /
   *  `keyAtEnd`, which are pure string arithmetic: they cannot throw and
   *  cannot write.
   *
   *  Nothing is lost by the restriction. Position applies to the create and
   *  never to the adopt — a record already in the tree stays where the user
   *  put it — so "next to that sibling" was never a property of the identity
   *  this call resolves, only of whichever device happened to create first. */
  position?: { kind: 'first' } | { kind: 'last' }
  /** May this existing block serve as the record? Soft-deleted blocks and
   *  blocks in another workspace are never offered (a deleted record was
   *  deleted on purpose, and silently resurrecting it is worse than making a
   *  new one). Default: any live block is adoptable. Return false and the
   *  call answers `taken` — it writes nothing and leaves the next move to
   *  you.
   *
   *  `parentId` is NOT checked for you, and the right answer differs by
   *  record kind, which is why it is a decision rather than a default. A
   *  POSITIONAL record — a set inside its lift, a lift inside its workout —
   *  is defined by where it sits, so a block the user dragged elsewhere is no
   *  longer that slot's occupant and should be rejected (`block.parentId ===
   *  parentId`): adopting it writes the record's children into another tree,
   *  where a parent-scoped read can never find them again. A record the user
   *  is free to FILE anywhere — a page, a top-level log — wants the opposite,
   *  because rejecting it strands the real record on a rejected slot and
   *  mints a duplicate beside it.
   *
   *  `block.properties` is the RAW bag: codec-ENCODED (a `date` reads as an
   *  ISO string, a `ref` as an id) and keyed by the literal property name
   *  with no schema resolution, so a renamed or shadowed property reads as
   *  `undefined`. Comparing a `Date` against it silently takes the wrong
   *  branch. Decode through the schema's codec for anything that isn't a
   *  plain string or number. */
  adoptable?: (block: BlockData) => boolean
}

/** Take an existing block as the record at some identity: repair the type
 *  tags it is missing and hand it back as it is on the way OUT.
 *
 *  Exported because the derived id is only ever the first place a caller
 *  looks. A caller that answers `taken` by finding the real record another
 *  way — scanning a parent's children for the one it means — is doing the
 *  same adopt, and should not have to reimplement (or quietly skip) the
 *  repair to get it. */
export const adoptTypedBlock = async (
  repo: Repo,
  tx: Tx,
  block: BlockData,
  types: readonly string[],
  typeSnapshot?: TypeRegistrySnapshot,
): Promise<Extract<DerivedChildOutcome, {status: 'adopted'}>> => {
  const missing = types.filter(typeId => !hasBlockType(block, typeId))
  for (const typeId of missing) {
    await repo.addTypeInTx(tx, block.id, typeId, {}, typeSnapshot)
  }
  // Re-read when we repaired something, so `block` describes the record as it
  // is on the way out rather than as it was on the way in — a caller reading
  // its types off the returned block would otherwise still see the tag
  // missing that this call just added.
  const repaired = missing.length > 0 ? await tx.get(block.id) : block
  return {status: 'adopted', id: block.id, block: repaired ?? block}
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
 * Know what that convergence is and isn't. It is row-level: you get one
 * record instead of two. It is NOT a merge — the losing insert is skipped
 * whole (`apply_block_creates` is insert-or-touch), and later edits settle
 * column-wise last-write-wins. So values only one writer ever wrote, and
 * which nothing re-asserts afterwards, are lost with the race. If a record's
 * FIELDS are genuinely written by two parties, this primitive gives you one
 * row and one winner, not both writers' data.
 *
 * ONE identity, ONE id. There is no fallback id and no probing for a free
 * one, because a fallback can only be chosen from what THIS device happens to
 * hold, and that is exactly the property a derived id exists to avoid. (The
 * probe this replaced: a device that had synced the finished occupant moved on
 * to a second id, while a device that hadn't still saw the first as free and
 * created there. Since `apply_block_creates` is insert-or-touch, that create
 * loses to the row already on the server — so the "new" record silently
 * BECOMES the finished one, and every child derived from its id lands inside a
 * tree the user considers closed.)
 *
 * So `adoptable` rejecting the occupant answers `taken` rather than moving
 * along, and this primitive is NOT the way to model "a second one of these,
 * deliberately". Two ways to model that:
 *
 *  - Put whatever distinguishes the second from the first INTO the key, where
 *    every device can see it. Best, when such a thing exists.
 *  - Fall back to a LOOKUP and a minted id: on `taken`, search for the record
 *    you mean (inside this same tx, where the answer cannot change between the
 *    read and the write), adopt it with `adoptTypedBlock` if it is there, and
 *    `createTypedChild` a random-id record if it is not. Two devices doing this
 *    at once get two visible records instead of one silently-shared one, which
 *    is the trade you want when there is genuinely nothing to key on.
 *
 * ```ts
 * await repo.tx(async tx => {
 *   const outcome = await getOrCreateTypedChild(repo, tx, {
 *     identity: {namespace: WORKOUT_NS, key: `${workspaceId}|${day}|${session}`},
 *     parentId: pageId,
 *     content: `Session ${session} · ${day}`,
 *     types: [WORKOUT_TYPE],
 *     properties: [propertyValue(statusProp, 'in-progress')],
 *     // A finished workout is not this evening's log.
 *     adoptable: block => block.properties[statusProp.name] !== 'done',
 *   })
 *   // …so tonight's SECOND session of the same type arrives here.
 *   if (outcome.status === 'taken') …
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
 * On adopt, everything describing the record's CONTENT — `content`,
 * `properties`, `position`, `references` — is deliberately not applied: the
 * block on disk holds real state, and overwriting it with the defaults this
 * caller happens to hold is the data loss the whole primitive exists to
 * avoid (a caller's default `position` would also re-home a record the user
 * moved). Callers wanting upsert semantics write their properties after the
 * call, where the intent is explicit. Missing `types` ARE re-tagged, so a
 * record that lost a type tag repairs itself.
 *
 * A caller that adopts must not then blind-write its own snapshot over the
 * record — that hands back with one statement exactly what the adopt
 * protected. Write the fields you actually changed.
 */
export const getOrCreateTypedChild = async (
  repo: Repo,
  tx: Tx,
  spec: DerivedChildSpec,
): Promise<DerivedChildOutcome> => {
  const {identity, adoptable, ...childSpec} = spec
  const id = derivedBlockId(identity)

  // Checked here rather than trusted from the type, because the callers this
  // primitive is FOR are the ones the type does not reach: a dynamic
  // extension is transpiled, not typechecked, and bridge `eval` is plain JS.
  // Rejected up front, before a single read or write, and on every path —
  // including the adopt, where placement is unused — so the answer to "is
  // this position supported" never depends on what happened to be sitting at
  // the derived id.
  const position = childSpec.position ?? {kind: 'last'}
  if (position.kind !== 'first' && position.kind !== 'last') {
    throw new Error(
      `getOrCreateTypedChild: position '${String((position as {kind: unknown}).kind)}' is not supported — a derived record places 'first' or 'last' only, because an anchored position re-keys siblings and can throw before the id is known to be free.`,
    )
  }

  const parent = await tx.get(childSpec.parentId)
  if (!parent || parent.deleted) {
    throw new Error(`getOrCreateTypedChild: parent ${childSpec.parentId} is missing or deleted`)
  }

  // A row in another workspace is never ours, whatever the key says: adopting
  // it would write this whole record's children into that workspace.
  const usable = (block: BlockData | null): boolean =>
    block !== null
    && !block.deleted
    && block.workspaceId === parent.workspaceId
    && (adoptable?.(block) ?? true)

  const existing = await tx.get(id)
  if (usable(existing)) {
    return adoptTypedBlock(repo, tx, existing as BlockData, childSpec.types, childSpec.typeSnapshot)
  }
  if (existing) return {status: 'taken', id, block: existing}

  const orderKey = await orderKeyForInsert(
    tx, childSpec.parentId, parent.workspaceId, position,
  )
  // `createOrGet`, not `createChild`: this is the insert the platform means
  // by a deterministic-id mint. It carries `systemMint` — which `createChild`
  // has no way to pass — and stamping 0 is not optional here. Per
  // `syncObserver/reconcile.ts`, two devices that mint the SAME derived id in
  // the same millisecond produce equal nonzero stamps from DIFFERENT writes,
  // which invariant I1 misreads as the same write and skips; the insert-or-
  // skip loser then strands, permanently divergent from the server. A
  // 0-stamped row always yields instead. It also gives us the cross-workspace
  // guard and insert-or-fetch atomicity for free.
  let inserted: boolean
  try {
    ;({inserted} = await tx.createOrGet({
      id,
      workspaceId: parent.workspaceId,
      parentId: childSpec.parentId,
      orderKey,
      content: childSpec.content ?? '',
      ...(childSpec.references !== undefined ? {references: [...childSpec.references]} : {}),
    }, {systemMint: true}))
  } catch (error) {
    // The two ways the id can be occupied by something `tx.get` didn't show
    // us: a tombstone, and a row of the same id in another workspace. Both
    // mean "not ours" — the same conclusion the read above draws for every
    // other occupant — so report it rather than aborting the caller's whole
    // transaction over a record it may well be happy to step past.
    if (error instanceof DeletedConflictError || error instanceof DeterministicIdCrossWorkspaceError) {
      return {status: 'taken', id, block: await tx.get(id)}
    }
    throw error
  }

  if (!inserted) {
    // Belt and braces. `tx.get` and `createOrGet`'s own lookup are the same
    // statement on the same connection inside one write transaction, so
    // nothing can claim the id between them — but if that ever stops being
    // true, the alternative is a caller's whole transaction aborting on a row
    // we had already decided what to do about.
    const claimed = await tx.get(id)
    if (usable(claimed)) {
      return adoptTypedBlock(repo, tx, claimed as BlockData, childSpec.types, childSpec.typeSnapshot)
    }
    return {status: 'taken', id, block: claimed}
  }

  for (const typeId of childSpec.types) {
    await repo.addTypeInTx(tx, id, typeId, {}, childSpec.typeSnapshot)
  }
  if (childSpec.properties && childSpec.properties.length > 0) {
    await tx.setProperties(id, {set: childSpec.properties})
  }
  return {status: 'created', id}
}
