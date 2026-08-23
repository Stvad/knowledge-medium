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
import { deleteSubtreeInTx } from './subtreeDelete'

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
    // the correct field/value children for `into` (PR #288 §9).
    const fromChildren = await tx.childrenOf(from.id, undefined, {hidePropertyChildren: true})
    if (fromChildren.length > 0) {
      const keys = keysBetween(lastVisibleOrderKey, null, fromChildren.length)
      for (let i = 0; i < fromChildren.length; i++) {
        await tx.move(fromChildren[i].id, {parentId: into.id, orderKey: keys[i]})
        intoChildIds.add(fromChildren[i].id)
        lastVisibleOrderKey = keys[i]
      }
    }

    // Fold `from`'s property-field children into `into`'s using the SAME §9
    // dedup the materializer runs for within-block duplicate field rows
    // (`collapseDuplicateFieldRow`) — this is the merge form of #23's
    // union-with-dedupe:
    //   - a `from` value equal to `into`'s winning value folds (its
    //     user-authored descendants ride onto `into`'s value);
    //   - a DIVERGENT `from` value is kept as a peer SIBLING value under the
    //     survivor field row (NOT nested under the winner as if it were an
    //     annotation — see `collapseDuplicateFieldRow`): projection reads the
    //     first value, so the cell keeps the winner while the conflicting one
    //     stays visible and reconcilable. It is never reclassified either:
    //     §9 recognition needs the `::` bit, and a value row doesn't carry
    //     one wherever it is moved. That
    //     is why no derived stamp is cleared here. The old path relocated
    //     losers to ORDINARY content and had to null a definition-shaped
    //     `reference_target_id` to stop them projecting as `into`'s field
    //     rows — but that column is content-derived and device-LOCAL, so the
    //     clear evaporated on the next edit and never synced (a peer kept
    //     hiding the row). Marked-form recognition removes the need entirely
    //     (#19): the loser is unmarked, so nothing can read it as machinery.
    //   - a property `into` LACKS: the whole `from` field row moves over
    //     intact (value + comments), becoming `into`'s field row for it.
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
    // Destination map, built the SAME way as `fromPropertyChildren` above:
    // raw children minus the visible ones, so a row counts as `into`'s field row
    // only when the canonical exclusion actually hid it — which carries
    // definition-ness AND the `::` bit with it. (It carries no flip gate:
    // recognition is content-derived and answers the same either side of the
    // flip — see `txEngine.childrenOf`.)
    //
    // Reading `referenceTargetId` off every raw child instead (the first version
    // of this, PR #386 review) skipped both. The column is a bare
    // content-derived stamp: ANY child that is a whole-block ref carries one, so
    // an ordinary `((definitionId))` child was recorded as the destination field
    // row, and `collapseDuplicateFieldRow` then relocated `from`'s real
    // values/comments under that unrelated block and tombstoned the genuine
    // field row. Reachable from the "Merge into…" picker, not just raw tooling:
    // its `searchByContent` has no property-child exclusion, so a property VALUE
    // row matches on its own text and can be picked as the target.
    //
    // Under flat §9 recognition this needs no special case for a value-row
    // `into`: every block hosts its own field rows through its `::` children at
    // any depth, so the same raw-minus-visible difference is the right answer
    // whether `into` is a page, a field row, or a value row.
    //
    // `intoAnchor` still walks EVERY raw child: it is the placement anchor for an
    // adopted field row, so it wants the last physical sibling, hidden or not.
    // Re-scanned per source: an earlier source's adopted field rows are `into`'s
    // now, and this one must collapse into them rather than adopt a second.
    await scanIntoChildren()

    // Pre-backfill catch-up (§5, #389 item 9). `into` holds a full cell and
    // zero field rows — the shape of a row the backfill has not reached yet, of
    // a row that arrives by sync, and of every row in an un-flipped workspace.
    // Without this, a key BOTH blocks hold takes the adopt branch below, and
    // since target-wins makes the merged bag a no-op for that key, MATERIALIZE
    // has no change to reconcile — so PROJECT rebuilds the cell from the only
    // field row present, `from`'s, and the target's value is gone. Silent, from
    // a plain backspace-at-start, and it uploads.
    //
    // Materializing `into`'s own row first restores the precondition the
    // adopt/collapse split assumes, so the ordinary `collapseDuplicateFieldRow`
    // path runs and the result matches a merge of two child-backed blocks:
    // target's value wins the cell, `from`'s divergent value survives as a peer.
    //
    // Must run BEFORE the adopt loop, not after: once `from`'s row is adopted,
    // `into` HAS a field row for that fieldId and the catch-up no longer fires.
    //
    // Deliberately NOT flip-gated, unlike every other writer of property
    // children (km-g5ev). `from` can carry a field row in an un-flipped
    // workspace because recognition is content-derived — a hand-written
    // `::((fieldId))` classifies like a generated one. Gate the catch-up there
    // and the adopt branch runs instead, leaving `into` with the SOURCE's value
    // as its only value row; the projection publishes that over the target's at
    // the first touch past the flip. Gating loses the data it looks like it
    // protects — pinned by "keeps the target-wins value reachable through a
    // later flip".
    //
    // The `has(fieldId)` clause is the condition for needing catch-up at all —
    // a key `into` already has a row for takes the collapse branch and wants
    // nothing. It doubles as DEFENCE IN DEPTH against a find-or-create letting
    // the cell overwrite an existing child that disagrees with it; deleting the
    // clause fails no test today (verified against the full suite).
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
      // `into` lacks this field. Adopt it only if the merged bag actually keeps
      // the property: a custom `mergeProperties` strategy can deliberately drop a
      // source-only key, and since `into` never had it the final `properties`
      // write is a no-op for that key — so MATERIALIZE wouldn't remove a moved
      // field row, and its projection would add the property back, overriding the
      // strategy. Orphan/unresolvable field rows (no schema) don't project, so
      // they ride along harmlessly.
      const schema = fieldId !== undefined
        ? tx.resolvePropertyFieldSchema(from.workspaceId, fieldId)
        : null
      if (schema !== null && !Object.prototype.hasOwnProperty.call(mergedProperties, schema.name)) {
        await deleteSubtreeInTx(tx, fromField.id)
        continue
      }
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
