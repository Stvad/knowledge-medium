import {
  CORE_BLOCK_MERGED_EVENT,
  MergeIntoDescendantError,
  type BlockData,
  type BlockMergeAliasRewrite,
  type Tx,
} from '@/data/api'
import { keysBetween } from './orderKey'
import { encodedPropertyValueToChildContent } from './propertyChildren'
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

  // Preserve user-visible property state before the subtree delete below
  // (PR #288 §9 preservation rule, tightened per adversarial review). Two
  // classes of `from`-side value text exist ONLY in the tree — the merged
  // bag cannot resurrect them: (a) unparseable value text (projection
  // removed the key but kept the row "visible/fixable in the tree"), and
  // (b) shadowed/orphan field rows (recognized but never projected). And
  // even a parseable value is lost when the bag-level merge picks `into`'s
  // value for the key. Rule: a value child whose content the merged bag
  // will NOT regenerate relocates VISIBLY under `into` (whole subtree —
  // comments ride along); values the bag regenerates just donate their
  // user-authored descendants and are deleted (into's re-materialization
  // recreates them).
  const mergedProperties = mergeProps(into.properties, from.properties)
  const fromPropertyChildren = (await tx.childrenOf(
    from.id, undefined,
  )).filter(child => !fromChildren.some(visible => visible.id === child.id))
  let relocateAnchor = (
    await tx.childrenOf(into.id, undefined, {hidePropertyChildren: true})
  ).at(-1)?.orderKey ?? null
  const relocateUnderInto = async (id: string): Promise<void> => {
    const [key] = keysBetween(relocateAnchor, null, 1)
    await tx.move(id, {parentId: into.id, orderKey: key})
    relocateAnchor = key
  }
  for (const fieldRow of fromPropertyChildren) {
    const fieldId = fieldRow.referenceTargetId ?? null
    const schema = fieldId !== null
      ? tx.resolvePropertyFieldSchema(from.workspaceId, fieldId)
      : null
    const mergedValueContent = schema
      && Object.prototype.hasOwnProperty.call(mergedProperties, schema.name)
      ? encodedPropertyValueToChildContent(schema, mergedProperties[schema.name])
      : null
    const values = await tx.childrenOf(fieldRow.id, undefined)
    for (const value of values) {
      if (mergedValueContent !== null && value.content === mergedValueContent) {
        // The bag regenerates this value on `into` — keep only its
        // user-authored descendants.
        const valueDescendants = await tx.childrenOf(
          value.id, undefined,
        )
        for (const descendant of valueDescendants) {
          await relocateUnderInto(descendant.id)
        }
      } else {
        // Tree-only value text (unparseable / shadowed / merge-losing):
        // deleting it would be silent data loss in effect — surface it.
        // Clear the derived column FIRST (adversarial-review round 2): a
        // ref-typed/wikilink value carries a definition-shaped
        // reference_target_id, and relocated under ordinary content it
        // would classify as a field row of `into` — hidden by the outline
        // predicate and re-projected over the merged bag in this very tx.
        // The column is derived state; the next content edit re-derives it
        // under the row's new (ordinary-content) role.
        if ((value.referenceTargetId ?? null) !== null) {
          await tx.update(value.id, {referenceTargetId: null}, {skipMetadata: true})
        }
        await relocateUnderInto(value.id)
      }
    }
  }

  // Drop `from`'s remaining (property-field) children — including any
  // still-attached value children — so no live rows dangle under the
  // tombstone once `from` is deleted (fixed in the spike at f4d0b447: a
  // bare delete had orphaned value rows).
  for (const child of fromPropertyChildren) {
    await deleteSubtreeInTx(tx, child.id)
  }

  // Delete before merging properties so aliases held by `from` are
  // released before they are added to `into`.
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
