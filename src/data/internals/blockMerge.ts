import {
  CORE_BLOCK_MERGED_EVENT,
  type BlockData,
  type BlockMergeAliasRewrite,
  type Tx,
} from '@/data/api'
import { keysBetween } from '../orderKey'
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
  const intoChildren = await tx.childrenOf(into.id)
  const fromChildren = await tx.childrenOf(from.id)
  if (fromChildren.length > 0) {
    const keys = keysBetween(intoChildren.at(-1)?.orderKey ?? null, null, fromChildren.length)
    for (let i = 0; i < fromChildren.length; i++) {
      await tx.move(fromChildren[i].id, {parentId: into.id, orderKey: keys[i]})
    }
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
