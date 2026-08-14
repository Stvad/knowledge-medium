import {
  CORE_BLOCK_MERGED_EVENT,
  MergeIntoDescendantError,
  MergeIntoOpaqueContentError,
  type BlockData,
  type BlockMergeAliasRewrite,
  type Tx,
} from '@/data/api'
import { keysBetween } from './orderKey'
import { hasOpaqueContent } from './properties'
import { getPropertyFieldTargetId } from './propertyChildren'
import { collapseDuplicateFieldRow } from './internals/propertyChildrenProcessor'
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

export const mergeBlocksInTx = async (
  tx: Tx,
  {
    into,
    from,
    contentStrategy = 'concat',
    mergeProperties: mergeProps = mergeProperties,
    aliasRewrites = [],
  }: MergeBlocksInTxArgs,
): Promise<void> => {
  // Merging a block into itself would tombstone it (delete), double its
  // content (read-after-delete via requireExisting), and orphan its children
  // under the tombstone. Treat self-merge as a no-op.
  if (into.id === from.id) return

  // Merging an already-tombstoned block is a retry of a merge that
  // already happened (e.g. the alias-collision "Merge into…" flow
  // re-firing, #188) — treat it as a no-op like self-merge. Without
  // this, the degenerate all-writes-elide case (tombstone delete
  // no-ops, content/properties update elides when `from` was empty)
  // reached emitEvent with no prior write in the tx and aborted with
  // WorkspaceNotPinnedError. Found by repoMutators.fuzz.
  if (from.deleted) return

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

  // The target's bytes are not prose, and the write below concatenates
  // `from`'s text straight into them. Up front with the other precondition,
  // BEFORE any child re-homing, so the refusal costs nothing to roll back.
  //
  // Refuse rather than fall back to `keepTarget`: `from` is deleted either
  // way, so keeping the target intact would silently destroy the SOURCE
  // block's text with nothing appended anywhere. Both outcomes lose data, so
  // it is the user's call. Reachable from MergePicker (a dialog-length pause
  // in which sync can add the type) and from Backspace-at-offset-0 when the
  // previous sibling is an extension block.
  if (hasOpaqueContent(into, tx.opaqueContentTypes)) {
    throw new MergeIntoOpaqueContentError(into.id, from.id)
  }

  // Re-parent only `from`'s regular (visible, non property-field) children
  // under `into` — the VISIBLE view (opt into `hidePropertyChildren`).
  // Property-field children are derived from the property bag and must NOT
  // be carried over: the merged bag written to `into` below re-materializes
  // the correct field/value children for `into` (PR #288 §9).
  const intoChildren = await tx.childrenOf(into.id, undefined, {hidePropertyChildren: true})
  const fromChildren = await tx.childrenOf(from.id, undefined, {hidePropertyChildren: true})
  if (fromChildren.length > 0) {
    const keys = keysBetween(intoChildren.at(-1)?.orderKey ?? null, null, fromChildren.length)
    for (let i = 0; i < fromChildren.length; i++) {
      await tx.move(fromChildren[i].id, {parentId: into.id, orderKey: keys[i]})
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
  const mergedProperties = mergeProps(into.properties, from.properties)
  const fromPropertyChildren = (await tx.childrenOf(
    from.id, undefined,
  )).filter(child => !fromChildren.some(visible => visible.id === child.id))
  // Destination map, built the SAME way as `fromPropertyChildren` above:
  // raw children minus the visible ones, so a row counts as `into`'s field row
  // only when the canonical exclusion actually hid it — which carries the flip
  // gate, definition-ness, AND the `::` bit with it.
  //
  // Reading `referenceTargetId` off every raw child instead (the first version
  // of this, PR #386 review) skipped all three. The column is a bare
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
  const intoFieldByFieldId = new Map<string, BlockData>()
  let intoAnchor: string | null = null
  for (const child of await tx.childrenOf(into.id, undefined)) {
    intoAnchor = child.orderKey
    if (intoChildren.some(visible => visible.id === child.id)) continue
    const fieldId = getPropertyFieldTargetId(child)
    if (fieldId !== undefined && !intoFieldByFieldId.has(fieldId)) {
      intoFieldByFieldId.set(fieldId, child)
    }
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

  // Delete before merging properties so aliases held by `from` are
  // released before they are added to `into`. `from`'s children have all
  // been re-homed (visible ones above, property ones just now), so nothing
  // is stranded live under the tombstone.
  await tx.delete(from.id)

  await tx.update(into.id, {
    content: computeMergedContent(into.content, from.content, contentStrategy),
    properties: mergedProperties,
  })

  tx.emitEvent(CORE_BLOCK_MERGED_EVENT, {
    workspaceId: from.workspaceId,
    fromId: from.id,
    intoId: into.id,
    aliasRewrites: [...aliasRewrites],
  })
}
