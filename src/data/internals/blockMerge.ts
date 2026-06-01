import {
  normalizeReferences,
  type BlockData,
  type BlockReference,
  type Tx,
} from '@/data/api'
import { keysBetween } from '../orderKey'
import { mergeProperties } from './mergeProperties'
import {
  parseReferences,
  renderAliasedBlockref,
  renderWikilink,
  rewriteBlockRefs,
  rewriteWikilinks,
} from '@/plugins/references/referenceParser'

export type ContentStrategy = 'concat' | 'keepTarget' | { separator: string }

export type MergePropertiesStrategy = (
  intoProps: Record<string, unknown>,
  fromProps: Record<string, unknown>,
) => Record<string, unknown>

export interface AliasRewrite {
  fromAlias: string
  toAlias: string
}

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

const replacementForAlias = (alias: string, targetId: string): string => {
  const candidate = renderWikilink(alias)
  if (parseReferences(candidate)[0]?.alias === alias) return candidate
  return renderAliasedBlockref(alias, targetId)
}

const retargetReference = (
  ref: BlockReference,
  fromId: string,
  intoId: string,
  aliasRewrites: ReadonlyMap<string, string>,
): BlockReference => {
  if (ref.id !== fromId) return ref
  const nextAlias = ref.alias === fromId
    ? intoId
    : aliasRewrites.get(ref.alias) ?? ref.alias
  return ref.sourceField === undefined
    ? {id: intoId, alias: nextAlias}
    : {id: intoId, alias: nextAlias, sourceField: ref.sourceField}
}

const retargetReferenceContent = (
  content: string,
  fromId: string,
  intoId: string,
  aliasRewrites: ReadonlyMap<string, string>,
): string => {
  let next = rewriteBlockRefs(content, fromId, intoId)
  for (const [fromAlias, toAlias] of aliasRewrites) {
    next = rewriteWikilinks(next, fromAlias, replacementForAlias(toAlias, intoId))
  }
  return next
}

const retargetReferencesToMergedBlock = async (
  tx: Tx,
  fromId: string,
  intoId: string,
  workspaceId: string,
  aliasRewrites: ReadonlyMap<string, string>,
): Promise<void> => {
  const sources = await tx.blocksReferencing(fromId, workspaceId)
  for (const source of sources) {
    const current = await tx.get(source.id)
    if (current === null || current.deleted) continue

    const nextReferences = normalizeReferences(
      current.references.map(ref => retargetReference(ref, fromId, intoId, aliasRewrites)),
    )
    const nextContent = retargetReferenceContent(
      current.content,
      fromId,
      intoId,
      aliasRewrites,
    )

    const patch: Partial<Pick<BlockData, 'content' | 'references'>> = {}
    if (nextContent !== current.content) patch.content = nextContent
    if (JSON.stringify(nextReferences) !== JSON.stringify(current.references)) {
      patch.references = nextReferences
    }
    if (Object.keys(patch).length === 0) continue
    await tx.update(current.id, patch, {skipMetadata: true})
  }
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

  await retargetReferencesToMergedBlock(
    tx,
    from.id,
    into.id,
    from.workspaceId,
    new Map(aliasRewrites.map(({fromAlias, toAlias}) => [fromAlias, toAlias])),
  )
}
