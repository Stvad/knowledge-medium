import {
  CORE_BLOCK_MERGED_EVENT,
  MergeIntoDescendantError,
  type AnyPropertySchema,
  type BlockData,
  type BlockMergeAliasRewrite,
  type Tx,
} from '@/data/api'
import { keysBetween } from './orderKey'
import { getPropertyFieldTargetId } from './propertyChildren'
import {
  collapseDuplicateFieldRow,
  materializePropertyChildrenForExistingRow,
} from './internals/propertyChildrenProcessor'
import { mergeProperties } from './mergeProperties'

export type ContentStrategy = 'concat' | 'keepTarget' | { separator: string }

export type MergePropertiesStrategy = (
  intoProps: Record<string, unknown>,
  fromProps: Record<string, unknown>,
) => Record<string, unknown>

export type AliasRewrite = BlockMergeAliasRewrite

export interface MergeBlocksInTxArgs {
  into: BlockData
  from: BlockData
  contentStrategy?: ContentStrategy
  mergeProperties?: MergePropertiesStrategy
  aliasRewrites?: readonly AliasRewrite[]
}

export interface FoldBlocksInTxArgs extends Omit<MergeBlocksInTxArgs, 'from'> {
  /** Folded in order, ids deduped. `mergeProperties` is applied cumulatively —
   *  each source merges into the bag the previous ones produced, not into
   *  `into`'s original. `aliasRewrites` is fold-wide and source-agnostic: the
   *  same set rides every emitted merge event, so a rewrite is applied once per
   *  source regardless of which one held the alias. */
  froms: readonly BlockData[]
}

export const computeMergedContent = (
  intoContent: string,
  fromContent: string,
  strategy: ContentStrategy,
): string => {
  if (strategy === 'concat') return intoContent + fromContent
  if (strategy === 'keepTarget') {
    return intoContent.length > 0 ? intoContent : fromContent
  }
  return intoContent + strategy.separator + fromContent
}

/** Fold one block into another. Thin wrapper — see `foldBlocksInTx`. */
export const mergeBlocksInTx = async (
  tx: Tx,
  {into, from, ...rest}: MergeBlocksInTxArgs,
): Promise<void> => foldBlocksInTx(tx, {into, froms: [from], ...rest})

/** Fold N blocks into one survivor, in a single transaction.
 *
 *  N sources rather than N calls because the survivor's property write has to
 *  come after EVERY source is released. Aliases are unique per workspace, so a
 *  bag carrying a name a not-yet-folded source still claims trips the
 *  uniqueness trigger and rolls back the whole transaction — which is how
 *  folding duplicates one at a time dead-ends, identically, on every retry.
 *
 *  Releasing by DELETING the sources rather than clearing their alias bags is
 *  also load-bearing: a delete drops their `block_aliases` rows while leaving
 *  the stored bag alone, so `references.renameBacklinks` — which reads the
 *  property diff — sees no release and leaves `[[Name]]` spans for the merge
 *  event to retarget. Clearing the bags instead reads as a rename with no
 *  replacement. */
export const foldBlocksInTx = async (
  tx: Tx,
  {
    into,
    froms,
    contentStrategy = 'concat',
    mergeProperties: mergeProps = mergeProperties,
    aliasRewrites = [],
  }: FoldBlocksInTxArgs,
): Promise<void> => {
  // Both grow as each source's visible children are re-homed, and both are
  // load-bearing. The anchor: a second source appended against the pre-fold
  // position interleaves with the first's children. The id set: it is what
  // `scanIntoChildren` treats as "already visible", and a re-homed child
  // missing from it gets read as a candidate field row on the strength of a
  // bare `referenceTargetId`, which any whole-block reference carries.
  const intoVisible = await tx.childrenOf(into.id, undefined, {hidePropertyChildren: true})
  const intoChildIds = new Set(intoVisible.map(child => child.id))
  let lastVisibleOrderKey: string | null = intoVisible.at(-1)?.orderKey ?? null

  // Accumulated across sources and written ONCE at the end — see the docblock.
  let mergedProperties = into.properties
  let mergedContent = into.content
  const folded: BlockData[] = []

  const intoFieldByFieldId = new Map<string, BlockData>()
  let intoAnchor: string | null = null
  const scanIntoChildren = async (): Promise<void> => {
    intoFieldByFieldId.clear()
    intoAnchor = null
    for (const child of await tx.childrenOf(into.id, undefined)) {
      intoAnchor = child.orderKey
      if (intoChildIds.has(child.id)) continue
      const fieldId = getPropertyFieldTargetId(child)
      if (fieldId !== undefined && !intoFieldByFieldId.has(fieldId)) {
        intoFieldByFieldId.set(fieldId, child)
      }
    }
  }

  for (const from of froms) {
    // A repeated id re-enters the body against the caller's PRE-LOOP snapshot,
    // so `from.deleted` below still reads false and cannot catch it: the fold
    // would merge its properties and concatenate its content a second time and
    // emit two merge events for one block.
    if (folded.some(done => done.id === from.id)) continue

    // Merging a block into itself would tombstone it (delete), double its
    // content (read-after-delete via requireExisting), and orphan its children
    // under the tombstone. Treat self-merge as a no-op.
    if (into.id === from.id) continue

    // Merging an already-tombstoned block is a retry of a merge that
    // already happened (e.g. the alias-collision "Merge into…" flow
    // re-firing, #188) — treat it as a no-op like self-merge. Without
    // this, the degenerate all-writes-elide case (tombstone delete
    // no-ops, content/properties update elides when `from` was empty)
    // reached emitEvent with no prior write in the tx and aborted with
    // WorkspaceNotPinnedError. Found by repoMutators.fuzz.
    if (from.deleted) continue

    // Merging `from` into one of its own descendants can never succeed: the
    // child re-homing below would move an ancestor of `into` under `into` and
    // trip `tx.move`'s cycle guard mid-fold (clean rollback, raw CycleError).
    // The alias-collision "Merge into…" button drives exactly this direction
    // when an aliased ancestor page is renamed onto a descendant page's alias,
    // so retries fail identically and the button gets stuck (#188). Pre-check
    // with the same ancestry walk the cycle guard uses and surface a typed,
    // user-actionable precondition error up front instead.
    if (await tx.isDescendantOf(into.id, from.id)) {
      throw new MergeIntoDescendantError(into.id, from.id)
    }

    // Re-parent only `from`'s regular (visible, non property-field) children
    // under `into` — the VISIBLE view (opt into `hidePropertyChildren`).
    // Property-field children are derived from the property bag and must NOT
    // be carried over: the merged bag written to `into` below re-materializes
    // the correct field/value children for `into` (docs/properties-as-blocks-migration.html §9).
    const fromChildren = await tx.childrenOf(from.id, undefined, {hidePropertyChildren: true})
    if (fromChildren.length > 0) {
      const keys = keysBetween(lastVisibleOrderKey, null, fromChildren.length)
      for (let i = 0; i < fromChildren.length; i++) {
        await tx.move(fromChildren[i].id, {parentId: into.id, orderKey: keys[i]})
        intoChildIds.add(fromChildren[i].id)
        lastVisibleOrderKey = keys[i]
      }
    }

    // Folds `from`'s property-field children into `into`'s via
    // `collapseDuplicateFieldRow`. A divergent `from` value stays a peer
    // SIBLING under the survivor field row, and nothing clears a derived stamp
    // on it — §9 recognition needs the `::` bit, which a value row never
    // carries wherever it is moved.
    //
    // `into` as it stands BEFORE this source folds in — what the pre-backfill
    // catch-up below judges against. Against the post-merge bag every
    // source-only key looks like one `into` already held, so the catch-up mints
    // a field row for it and the adopt branch collapses the source's real row
    // into that fresh one: recreated, not moved (#23).
    const intoBefore: BlockData = {...into, properties: mergedProperties}
    mergedProperties = mergeProps(mergedProperties, from.properties)
    const fromPropertyChildren = (await tx.childrenOf(
      from.id, undefined,
    )).filter(child => !fromChildren.some(visible => visible.id === child.id))
    // Built the SAME raw-minus-visible way as `fromPropertyChildren`, so a row
    // counts as a field row only where the canonical exclusion hid it — which
    // carries definition-ness AND the `::` bit. Reading `referenceTargetId` off
    // raw children instead matches ANY whole-block ref, and
    // `collapseDuplicateFieldRow` then relocates `from`'s values under that
    // unrelated block.
    //
    // `intoAnchor` still walks EVERY raw child: it is the placement anchor for
    // an adopted row and wants the last physical sibling, hidden or not.
    // Re-scanned per source so a later source collapses into an earlier one's
    // adopted rows.
    await scanIntoChildren()

    // Materialize `into`'s own field row for a key BOTH blocks hold before the
    // adopt loop below — after adoption `into` has a row and this no longer
    // fires. Without it, target-wins makes the merged bag a no-op for that key,
    // so PROJECT rebuilds the cell from `from`'s row and the target's value is
    // silently lost.
    //
    // Deliberately NOT flip-gated (km-g5ev), unlike the other property-child
    // writers: recognition is content-derived, so gating leaves the SOURCE's
    // value as `into`'s only value row, which projection publishes over the
    // target's at the first touch past the flip.
    //
    // The `has(fieldId)` clause is defence in depth — deleting it fails no test
    // today.
    const pendingByName = new Map<string, AnyPropertySchema & {fieldId: string}>()
    for (const fromField of fromPropertyChildren) {
      const fieldId = getPropertyFieldTargetId(fromField)
      if (fieldId === undefined || intoFieldByFieldId.has(fieldId)) continue
      const schema = tx.resolvePropertyFieldSchema(into.workspaceId, fieldId)
      if (schema === null || !Object.hasOwn(intoBefore.properties, schema.name)) continue
      pendingByName.set(schema.name, {...schema, fieldId})
    }
    if (pendingByName.size > 0) {
      await materializePropertyChildrenForExistingRow(
        tx,
        intoBefore,
        // The names this call is about, resolved by the fieldId they came from —
        // narrower than a workspace resolver by construction, so it cannot
        // materialize a key the merge did not ask for.
        {resolveNameSchema: name => pendingByName.get(name)},
        [...pendingByName.keys()],
      )
      await scanIntoChildren()
    }
    for (const fromField of fromPropertyChildren) {
      const fieldId = getPropertyFieldTargetId(fromField)
      const intoField = fieldId !== undefined ? intoFieldByFieldId.get(fieldId) : undefined
      if (intoField) {
        // Merges into `into`'s existing field row for this property, deleting
        // `fromField` and preserving every `from` value (folded or nested). When
        // the merged bag drops a key `into` HAD, the `properties` write below is
        // a real change for it, so MATERIALIZE reconciles `into`'s own children
        // away — no special handling needed here.
        await collapseDuplicateFieldRow(tx, intoField.id, fromField)
        continue
      }
      // `into` lacks this field, so there is nothing to dedupe against — move
      // the row over intact. A merge RELOCATES and never reaps: the only rows it
      // may tombstone are husks something emptied first (`collapseDuplicateFieldRow`
      // above, `from` itself below), and a field row carries user-authored
      // descendants at any depth.
      //
      // Deliberate consequence: a `mergeProperties` strategy that drops a key
      // whose rows survive does NOT remove the property — PROJECT re-derives it
      // from the moved row. Child-backed properties are owned by their rows
      // (§5's one-direction rule), so dropping the key is not a way to delete
      // one; a strategy that means it has to remove the rows itself, knowing
      // what is nested under them (#728).
      const [key] = keysBetween(intoAnchor, null, 1)
      await tx.move(fromField.id, {parentId: into.id, orderKey: key})
      intoAnchor = key
      if (fieldId !== undefined) intoFieldByFieldId.set(fieldId, fromField)
    }

    mergedContent = computeMergedContent(mergedContent, from.content, contentStrategy)
    // Delete before the survivor's write so aliases held by `from` are released
    // before they are added to `into`. `from`'s children have all been re-homed
    // (visible ones above, property ones just now), so nothing is stranded live
    // under the tombstone.
    await tx.delete(from.id)
    folded.push(from)
  }

  // Every source was a no-op (self-merge or already tombstoned). Defence in
  // depth: the update below is a no-change write that elides and events are
  // per-source, so deleting this fails nothing today. It keeps "a no-op merge
  // writes nothing" a property of the control flow rather than of
  // write-elision.
  if (folded.length === 0) return

  await tx.update(into.id, {content: mergedContent, properties: mergedProperties})

  for (const from of folded) {
    tx.emitEvent(CORE_BLOCK_MERGED_EVENT, {
      workspaceId: from.workspaceId,
      fromId: from.id,
      intoId: into.id,
      aliasRewrites: [...aliasRewrites],
    })
  }
}
