import {
  CORE_BLOCK_MERGED_EVENT,
  MergeIntoDescendantError,
  type BlockData,
  type BlockMergeAliasRewrite,
  type Tx,
} from '@/data/api'
import { keysBetween } from './orderKey'
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

/** Recursively soft-delete a block and every descendant (property-field
 *  rows AND their value children). `tx.delete` only tombstones the row
 *  passed to it, so a bare delete of a materialized field row would leave
 *  its value children live-but-orphaned under a tombstone (still
 *  indexed/uploaded). */
const deleteSubtreeInTx = async (tx: Tx, id: string): Promise<void> => {
  const children = await tx.childrenOf(id, undefined, {includePropertyChildren: true})
  for (const child of children) {
    await deleteSubtreeInTx(tx, child.id)
  }
  await tx.delete(id)
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
  // under `into` — childrenOf's flip-gated default. Property-field children
  // are derived from the property bag and must NOT be carried over: the
  // merged bag written to `into` below re-materializes the correct
  // field/value children for `into` (PR #288 §9).
  const intoChildren = await tx.childrenOf(into.id)
  const fromChildren = await tx.childrenOf(from.id)
  if (fromChildren.length > 0) {
    const keys = keysBetween(intoChildren.at(-1)?.orderKey ?? null, null, fromChildren.length)
    for (let i = 0; i < fromChildren.length; i++) {
      await tx.move(fromChildren[i].id, {parentId: into.id, orderKey: keys[i]})
    }
  }

  // Preserve user-authored descendants of `from`'s VALUE children before the
  // subtree delete below (PR #288 §9 preservation rule): a comment thread
  // under a value child is user content — a bare subtree-delete would
  // silently tombstone it with the machinery rows. Re-home them under `into`
  // (the merged bag re-materializes `into`'s own field/value rows in this
  // same tx, but their ids aren't knowable here, so `into` itself is the
  // stable visible destination).
  const fromPropertyChildren = (await tx.childrenOf(
    from.id, undefined, {includePropertyChildren: true},
  )).filter(child => !fromChildren.some(visible => visible.id === child.id))
  for (const fieldRow of fromPropertyChildren) {
    const values = await tx.childrenOf(fieldRow.id, undefined, {includePropertyChildren: true})
    for (const value of values) {
      const valueDescendants = await tx.childrenOf(
        value.id, undefined, {includePropertyChildren: true},
      )
      if (valueDescendants.length === 0) continue
      const anchor = (await tx.childrenOf(into.id)).at(-1)?.orderKey ?? null
      const keys = keysBetween(anchor, null, valueDescendants.length)
      for (let i = 0; i < valueDescendants.length; i++) {
        await tx.move(valueDescendants[i].id, {parentId: into.id, orderKey: keys[i]})
      }
    }
  }

  // Drop `from`'s remaining (property-field) children — including their
  // value children — so no live rows dangle under the tombstone once `from`
  // is deleted (fixed in the spike at f4d0b447: a bare delete had orphaned
  // value rows).
  for (const child of fromPropertyChildren) {
    await deleteSubtreeInTx(tx, child.id)
  }

  // Delete before merging properties so aliases held by `from` are
  // released before they are added to `into`.
  await tx.delete(from.id)

  await tx.update(into.id, {
    content: computeMergedContent(into.content, from.content, contentStrategy),
    properties: mergeProps(into.properties, from.properties),
  })

  tx.emitEvent(CORE_BLOCK_MERGED_EVENT, {
    workspaceId: from.workspaceId,
    fromId: from.id,
    intoId: into.id,
    aliasRewrites: [...aliasRewrites],
  })
}
