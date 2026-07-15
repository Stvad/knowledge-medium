import {
  CORE_BLOCK_MERGED_EVENT,
  defineSameTxProcessor,
  isRefCodec,
  isRefListCodec,
  normalizeReferences,
  type AnyPropertySchema,
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
import { inlineDeletedBlockRefsProcessor } from './inlineDeletedBlockRefsProcessor.ts'

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

/** Rewrite `fromId` → `intoId` inside a ref/refList property's RAW encoded
 *  value (string or string array — matching what `decodeRefId` /
 *  `decodeRefListIds` accept). Works on the raw value rather than a
 *  decode→re-encode round-trip so malformed sibling elements a lenient
 *  decode would drop are preserved verbatim. List rewrites dedupe every
 *  `intoId` element once a rewrite has fired — both the entry the
 *  rewrite itself introduces (`[from, into]` must not become
 *  `[into, into]`) and any pre-existing `intoId` duplicate already in
 *  the list; both are benign canonicalizations. String rewrites also
 *  drop surrounding whitespace padding around a matched `fromId`
 *  (`raw.trim() === fromId` matches, but the replacement is the bare
 *  `intoId`) — same reasoning. */
const rewriteRefValue = (
  raw: unknown,
  fromId: string,
  intoId: string,
): {value: unknown; changed: boolean} => {
  if (typeof raw === 'string') {
    return raw.trim() === fromId ? {value: intoId, changed: true} : {value: raw, changed: false}
  }
  if (Array.isArray(raw)) {
    let changed = false
    const mapped = raw.map(el =>
      typeof el === 'string' && el.trim() === fromId ? (changed = true, intoId) : el)
    if (!changed) return {value: raw, changed: false}
    let seenInto = false
    const deduped = mapped.filter(el => {
      if (typeof el === 'string' && el.trim() === intoId) {
        if (seenInto) return false
        seenInto = true
      }
      return true
    })
    return {value: deduped, changed: true}
  }
  return {value: raw, changed: false}
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
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<void> => {
  const current = await tx.get(sourceId)
  if (current === null || current.deleted) return

  // Property-derived refs (sourceField set) project from the property
  // VALUE (`projectPropertyReferences`), so a retargeted ref entry whose
  // underlying value still names `fromId` is a projection anomaly the
  // next re-parse would silently revert (found by
  // referencesRecompute.fuzz.test.ts). Rewrite the value alongside the
  // entry when the schema is loaded and ref-typed; otherwise leave BOTH
  // untouched — an absent-schema ref is value-tied by the add-only
  // contract, and a non-ref/undecodable value never projected this ref
  // in the first place (pre-existing incoherence isn't ours to mutate).
  const nextProperties = {...current.properties}
  let propertiesChanged = false
  const retargetableFields = new Set<string>()
  for (const ref of current.references) {
    if (ref.id !== event.fromId || ref.sourceField === undefined) continue
    if (retargetableFields.has(ref.sourceField)) continue
    const schema = propertySchemas.get(ref.sourceField)
    if (!schema || !(isRefCodec(schema.codec) || isRefListCodec(schema.codec))) continue
    const {value, changed} = rewriteRefValue(
      nextProperties[ref.sourceField], event.fromId, event.intoId)
    if (changed) {
      nextProperties[ref.sourceField] = value
      propertiesChanged = true
      retargetableFields.add(ref.sourceField)
    }
  }

  const nextReferences = normalizeReferences(
    current.references.map(ref =>
      ref.sourceField !== undefined && !retargetableFields.has(ref.sourceField)
        ? ref
        : retargetReference(ref, event.fromId, event.intoId, aliasRewrites),
    ),
  )
  const nextContent = retargetReferenceContent(
    current.content,
    event.fromId,
    event.intoId,
    aliasRewrites,
  )

  const patch: Partial<Pick<BlockData, 'content' | 'properties' | 'references'>> = {}
  if (nextContent !== current.content) patch.content = nextContent
  // This write (including the properties bag) runs under the merge tx's
  // BlockDefault scope, so if a canonical seed bag ever gains a ref/
  // refList-typed field, merging a block referenced BY a seed definition
  // would abort at the commit-time seed guard (assertNoSeedDefinitionWrites).
  // Unreachable today: canonical bags carry no ref-typed fields.
  if (propertiesChanged) patch.properties = nextProperties
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
    await retargetSource(ctx.tx, id, event, aliasRewrites, ctx.propertySchemas)
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
  inlineDeletedBlockRefsProcessor,
]
