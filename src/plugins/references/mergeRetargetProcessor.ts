import {
  CORE_BLOCK_MERGED_EVENT,
  defineSameTxProcessor,
  normalizeReferences,
  type AnySameTxProcessor,
  type BlockData,
  type BlockReference,
  type CoreBlockMergedEvent,
  type SameTxCtx,
  type Tx,
} from '@/data/api'
import {
  parseReferences,
  renderAliasedBlockref,
  renderWikilink,
  rewriteBlockRefs,
  rewriteWikilinks,
} from './referenceParser.ts'

export const RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR =
  'references.retargetMergedBlockReferences'

const SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL = `
  SELECT DISTINCT br.source_id AS id
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  WHERE br.workspace_id = ?
    AND br.target_id = ?
    AND source.deleted = 0
  ORDER BY source.order_key, source.id
`

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

const retargetSource = async (
  tx: Tx,
  sourceId: string,
  event: CoreBlockMergedEvent,
  aliasRewrites: ReadonlyMap<string, string>,
): Promise<void> => {
  const current = await tx.get(sourceId)
  if (current === null || current.deleted) return

  const nextReferences = normalizeReferences(
    current.references.map(ref =>
      retargetReference(ref, event.fromId, event.intoId, aliasRewrites),
    ),
  )
  const nextContent = retargetReferenceContent(
    current.content,
    event.fromId,
    event.intoId,
    aliasRewrites,
  )

  const patch: Partial<Pick<BlockData, 'content' | 'references'>> = {}
  if (nextContent !== current.content) patch.content = nextContent
  if (JSON.stringify(nextReferences) !== JSON.stringify(current.references)) {
    patch.references = nextReferences
  }
  if (Object.keys(patch).length === 0) return
  await tx.update(current.id, patch, {skipMetadata: true})
}

const retargetMergedBlockReferences = async (
  event: CoreBlockMergedEvent,
  ctx: SameTxCtx,
): Promise<void> => {
  const sourceRows = await ctx.db.getAll<{id: string}>(
    SELECT_LIVE_REFERENCE_SOURCE_IDS_SQL,
    [event.workspaceId, event.fromId],
  )
  if (sourceRows.length === 0) return

  const aliasRewrites = new Map(
    event.aliasRewrites.map(({fromAlias, toAlias}) => [fromAlias, toAlias]),
  )
  for (const {id} of sourceRows) {
    await retargetSource(ctx.tx, id, event, aliasRewrites)
  }
}

export const retargetMergedBlockReferencesProcessor = defineSameTxProcessor({
  name: RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR,
  watches: {kind: 'event', events: [CORE_BLOCK_MERGED_EVENT]},
  apply: async (event, ctx) => {
    for (const emitted of event.emittedEvents) {
      await retargetMergedBlockReferences(
        emitted.payload as CoreBlockMergedEvent,
        ctx,
      )
    }
  },
})

export const referencesSameTxProcessors: ReadonlyArray<AnySameTxProcessor> = [
  retargetMergedBlockReferencesProcessor,
]
