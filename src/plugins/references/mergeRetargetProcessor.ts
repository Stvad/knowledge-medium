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
} from '@/data/api'
import {
  deriveReferenceColumns,
  sameTxReferenceTargetLookups,
} from '@/data/internals/referenceTargetProcessor'
import {
  faithfulWikilinkReplacement,
  pinnedSpanReplacement,
  rewriteBlockRefs,
  rewriteWikilinks,
  type SpanReplacement,
} from './referenceParser.ts'
import { inlineDeletedBlockRefsProcessor } from './inlineDeletedBlockRefsProcessor.ts'
import { projectedIdOf } from './referenceProjection.ts'

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

/** Resolve each `fromAlias → toAlias` pair to a verified span
 *  replacement, once per merge event (the decision depends only on
 *  `toAlias` + `intoId`, never on the source being rewritten).
 *
 *  Pairs whose replacement can't round-trip are DROPPED from the map
 *  entirely rather than emitted unverified — writing text that doesn't
 *  parse would destroy the span outright. Both the content rewrite and
 *  `retargetReference` read this same map, so a dropped pair is dropped
 *  consistently on both sides rather than re-aliasing the stored entry
 *  to a name the content never got.
 *
 *  That is damage control, not coherence: a dropped pair still leaves
 *  `[[fromAlias]]` in content while the entry retargets to `intoId`,
 *  which no longer claims that name, so the next parse re-seats it.
 *  Unreachable in practice — the drop arm needs a non-UUID `intoId`,
 *  and every id generator here is uuidv4/uuidv5. */
const resolveAliasReplacements = (
  aliasRewrites: readonly {fromAlias: string; toAlias: string}[],
  intoId: string,
): Map<string, SpanReplacement> => {
  const out = new Map<string, SpanReplacement>()
  for (const {fromAlias, toAlias} of aliasRewrites) {
    const wikilink = faithfulWikilinkReplacement(toAlias)
    if (wikilink !== null) {
      out.set(fromAlias, wikilink)
      continue
    }
    // The wikilink form can't carry `toAlias`; pin to the merge target
    // instead. NOTE the label is `toAlias`, not the source author's
    // original text — an alias-collision merge deliberately re-titles
    // the span to the surviving name. (`replacementFor` on the rename
    // side pins the REMOVED alias, which does preserve what the author
    // wrote; the two look alike and mean different things.)
    const pinned = pinnedSpanReplacement(toAlias, intoId)
    if (pinned === null) {
      console.warn(
        `[${RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR}] merge target "${intoId}" ` +
        `cannot be pinned (not UUID-shaped) and alias "${toAlias}" is not ` +
        `wikilink-safe; leaving [[${fromAlias}]] spans unrewritten`,
      )
      continue
    }
    if (pinned.lossyLabel) {
      console.warn(
        `[${RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR}] pinned span for alias ` +
        `"${toAlias}" displays sanitized text; link preserved`,
      )
    }
    out.set(fromAlias, pinned)
  }
  return out
}

const retargetReference = (
  ref: BlockReference,
  fromId: string,
  intoId: string,
  aliasReplacements: ReadonlyMap<string, SpanReplacement>,
): BlockReference => {
  if (ref.id !== fromId) return ref
  // `refAlias`, not the bare `toAlias`: when the rewrite fell back to
  // the pinned form the content now reads `[toAlias](((intoId)))`,
  // which re-parses to a blockref edge whose alias IS the id. Keying
  // the entry on `toAlias` left the stored list disagreeing with the
  // content it was supposed to mirror until the next re-parse.
  const nextAlias = ref.alias === fromId
    ? intoId
    : aliasReplacements.get(ref.alias)?.refAlias ?? ref.alias
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
 *  (element matching goes through `projectedIdOf`, the same trim/empty
 *  normalization `appendPropertyRef` uses, so `raw.trim() === fromId`
 *  matches, but the replacement is the bare `intoId`) — same reasoning. */
const rewriteRefValue = (
  raw: unknown,
  fromId: string,
  intoId: string,
): {value: unknown; changed: boolean} => {
  if (typeof raw === 'string') {
    return projectedIdOf(raw) === fromId
      ? {value: intoId, changed: true}
      : {value: raw, changed: false}
  }
  if (Array.isArray(raw)) {
    let changed = false
    const mapped = raw.map(el =>
      projectedIdOf(el) === fromId ? (changed = true, intoId) : el)
    if (!changed) return {value: raw, changed: false}
    let seenInto = false
    const deduped = mapped.filter(el => {
      if (projectedIdOf(el) === intoId) {
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
  aliasReplacements: ReadonlyMap<string, SpanReplacement>,
): string => {
  let next = rewriteBlockRefs(content, fromId, intoId)
  for (const [fromAlias, replacement] of aliasReplacements) {
    next = rewriteWikilinks(next, fromAlias, replacement.text)
  }
  return next
}

const retargetSource = async (
  ctx: SameTxCtx,
  sourceId: string,
  event: CoreBlockMergedEvent,
  aliasReplacements: ReadonlyMap<string, SpanReplacement>,
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
): Promise<void> => {
  const tx = ctx.tx
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
  // Eligibility for the value+entry rewrite: schema present and ref-typed.
  // The field's DECLARED scope is deliberately IGNORED. A merge must not
  // leave a pointer dangling at the tombstoned source, so it retargets
  // ref/refList values regardless of the field's own scope — the same thing
  // the value-child CONTENT path (`retargetReferenceContent` below) already
  // does unconditionally. Gating the cell here but not the child made the
  // two disagree (the child's `((from))` retargeted, PROJECT then rebuilt
  // the cell the guard had "protected"); dropping the gate makes cell and
  // child converge (PR #386 review, F7). The value lands via the raw
  // `properties` patch below in THIS tx's scope (BlockDefault), which makes
  // the retarget undoable-with-the-merge — the correct semantics: undoing
  // the merge restores the pointer. A plain `set` picks the field's default
  // undo/routing bucket; a merge is exactly a case where overriding that is
  // right (Vlad, PR #386). Safe because BlockDefault is the STRICTEST
  // read-only policy, so touching a permissive-scope field can't bypass a
  // read-only gate, and every scope uploads to the server regardless.
  const isEligibleField = (field: string): boolean => {
    const schema = propertySchemas.get(field)
    return !!schema && (isRefCodec(schema.codec) || isRefListCodec(schema.codec))
  }
  // Collect eligible fields from BOTH directions:
  //  - stored entries pointing at fromId (a field whose VALUE was
  //    deleted can still carry a stale entry — sync-applied rows), and
  //  - the bag itself: mergeProperties can have copied a ref property
  //    from `from` onto this very row with a value naming fromId and NO
  //    stored entry yet — entry-driven collection can't see it, and the
  //    follow-up parse would project a backlink to the tombstoned merge
  //    source (Codex review on PR #371).
  // Eligible fields ALWAYS retarget their entries, whether or not the
  // value needed rewriting (a stale entry can coexist with an
  // already-correct value on sync-applied rows); the value write stays
  // conditional on an actual change.
  const retargetableFields = new Set<string>()
  for (const ref of current.references) {
    if (ref.id !== event.fromId || ref.sourceField === undefined) continue
    if (isEligibleField(ref.sourceField)) retargetableFields.add(ref.sourceField)
  }
  for (const field of Object.keys(nextProperties)) {
    if (isEligibleField(field)) retargetableFields.add(field)
  }
  for (const field of retargetableFields) {
    if (!(field in nextProperties)) continue
    const {value, changed} = rewriteRefValue(
      nextProperties[field], event.fromId, event.intoId)
    if (changed) {
      nextProperties[field] = value
      propertiesChanged = true
    }
  }

  const nextReferences = normalizeReferences(
    current.references.map(ref =>
      ref.sourceField !== undefined && !retargetableFields.has(ref.sourceField)
        ? ref
        : retargetReference(ref, event.fromId, event.intoId, aliasReplacements),
    ),
  )
  const nextContent = retargetReferenceContent(
    current.content,
    event.fromId,
    event.intoId,
    aliasReplacements,
  )

  const patch: Partial<Pick<BlockData, 'content' | 'properties' | 'references' | 'referenceTargetId' | 'isFieldForm'>> = {}
  if (nextContent !== current.content) {
    patch.content = nextContent
    // `core.deriveReferenceTarget` already ran earlier in this same tx pass
    // (kernel processors precede plugin ones) and stamped the column from
    // the PRE-retarget content. A whole-block `((old))` row would otherwise
    // keep `referenceTargetId: old` even though content now reads
    // `((new))` — recompute from the rewritten content so the column and
    // content never disagree.
    const lookups = sameTxReferenceTargetLookups(tx)
    const derived = await deriveReferenceColumns(nextContent, current.workspaceId, lookups)
    // This is always an update of an existing row (never a create), so an
    // unresolvable alias (`undefined`) clears the column rather than
    // preserving a caller-provided id the way the derive processor's
    // create path does.
    const nextTargetId = derived.targetId ?? null
    if ((current.referenceTargetId ?? null) !== nextTargetId) {
      patch.referenceTargetId = nextTargetId
    }
    if ((current.isFieldForm ?? false) !== derived.isFieldForm) {
      patch.isFieldForm = derived.isFieldForm
    }
  }
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
  // The merge TARGET is always a source candidate, backlink row or not:
  // mergeProperties can have copied a ref/refList property from `from`
  // onto `into` (target lacked the key) whose value names `fromId` —
  // `into` has no stored reference entry yet, so the block_references
  // lookup above can't see it, and without a rewrite the follow-up
  // parse would project a backlink to the tombstoned merge source
  // (Codex review on PR #371). retargetSource no-ops when nothing
  // matches.
  const sourceIds = new Set(sourceRows.map(row => row.id))
  sourceIds.add(event.intoId)

  const aliasReplacements = resolveAliasReplacements(event.aliasRewrites, event.intoId)
  for (const id of sourceIds) {
    await retargetSource(ctx, id, event, aliasReplacements, ctx.propertySchemas)
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
