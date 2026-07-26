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
  parseReferences,
  rewriteBlockRefs,
  rewriteWikilinks,
  type SpanReplacement,
} from './referenceParser.ts'
import { preferredSpanReplacement } from './spanReplacement.ts'
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
 *  A pair whose replacement can't round-trip maps to `null` rather than
 *  being emitted unverified — writing text that doesn't parse would
 *  destroy the span outright. Both the content rewrite and
 *  `retargetReference` read this same map, so an unrenderable pair is
 *  handled consistently on both sides: content keeps `[[fromAlias]]` and
 *  the stored entry is dropped for the re-parse to rebuild, rather than
 *  re-aliasing the entry to a name the content never got.
 *
 *  Reachable whenever BOTH rungs of the ladder fail. Not (as this
 *  previously claimed) only via a non-UUID `intoId` — every id generator
 *  here is uuidv4/uuidv5, but a surviving alias containing `[[` defeats
 *  the wikilink form and is refused by the pinned form as a
 *  delimiter-smuggling label, with no id involved. */
const resolveAliasReplacements = (
  aliasRewrites: readonly {fromAlias: string; toAlias: string}[],
  intoId: string,
): Map<string, SpanReplacement | null> => {
  const out = new Map<string, SpanReplacement | null>()
  for (const {fromAlias, toAlias} of aliasRewrites) {
    // `pinLabel` is `toAlias`, NOT the source author's original text —
    // an alias-collision merge deliberately re-titles the span to the
    // surviving name. (The rename side pins the REMOVED alias, which
    // does preserve what the author wrote; same ladder, different
    // label, and the difference matters.)
    const replacement = preferredSpanReplacement({
      wikilinkAlias: toAlias,
      pinLabel: toAlias,
      targetId: intoId,
      context: RETARGET_MERGED_BLOCK_REFERENCES_PROCESSOR,
    })
    // `null` is RECORDED, not skipped. It means "we meant to rewrite
    // this alias and could not render any form of it", which the entry
    // retarget below has to know about: dropping the key entirely made
    // an unrenderable pair indistinguishable from an alias that was
    // never in this merge, and those two want opposite handling.
    out.set(fromAlias, replacement)
  }
  return out
}

const retargetReference = (
  ref: BlockReference,
  fromId: string,
  intoId: string,
  aliasReplacements: ReadonlyMap<string, SpanReplacement | null>,
): BlockReference | null => {
  if (ref.id !== fromId) return ref
  // An alias this merge MEANT to rewrite but could not render leaves the
  // content saying `[[fromAlias]]`. Moving its edge to `intoId` writes an
  // entry the content does not support: the merge strips `fromAlias` from
  // the surviving block, so a re-parse of that span binds it to a fresh
  // seat, not to `intoId`. Neither target is right, and only a re-parse
  // can say what is — so DROP the entry and hand ownership over.
  //
  // Dropping rather than keeping it verbatim is the load-bearing part.
  // Keeping it leaves `nextReferences` byte-identical, `retargetSource`
  // produces no patch, nothing is written — and since this can be the
  // source's only affected reference, no watched field ever changes and
  // the re-parse this defers to is never scheduled. The edge would stay
  // pinned to the tombstoned `fromId` permanently. `parseReferences`
  // watches `references` as well as `content`, so removing the entry is
  // itself the trigger that gets it rebuilt.
  //
  // (Reachable whenever both ladder rungs fail — e.g. a surviving alias
  // containing `[[`, which the wikilink form cannot carry and the pinned
  // form refuses as a delimiter-smuggling label.)
  if (ref.alias !== fromId && aliasReplacements.get(ref.alias) === null) return null
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

/** Map a source's whole `references` list across the merge.
 *
 *  Exported for a direct unit test: this runs in the same tx as the
 *  content rewrite, and `parseReferences` re-derives the same list
 *  moments later, so asserting it through the processor proves nothing.
 *  The window BEFORE that re-parse is the point — a backlink query or a
 *  rename landing inside it reads what this wrote.
 *
 *  Three outcomes per entry: dropped (the rewrite could not be rendered,
 *  so only a re-parse can say what the span means now), retained
 *  ALONGSIDE its replacement (a page embed survived the rewrite and
 *  shares this one normalized entry), or replaced. */
export const retargetReferences = (
  refs: ReadonlyArray<BlockReference>,
  fromId: string,
  intoId: string,
  aliasReplacements: ReadonlyMap<string, SpanReplacement | null>,
  retainedAliases: ReadonlySet<string>,
  retargetableFields: ReadonlySet<string>,
): BlockReference[] =>
  normalizeReferences(refs.flatMap(ref => {
    if (ref.sourceField !== undefined && !retargetableFields.has(ref.sourceField)) return [ref]
    const retargeted = retargetReference(ref, fromId, intoId, aliasReplacements)
    if (retargeted === null) return []
    // Retention is a CONTENT concern only: it exists because one
    // normalized entry serves both `[[a]]` and a `![[a]]` the rewrite
    // stepped over. A property-derived edge projects from the property
    // VALUE, which has already been rewritten to `intoId` above — keeping
    // its old entry would leave a `sourceField` edge pointing at the
    // tombstoned block until the next reprojection, with no surviving
    // span to justify it.
    const retain = ref.sourceField === undefined && retainedAliases.has(ref.alias)
    return retain ? [ref, retargeted] : [retargeted]
  }))

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
  aliasReplacements: ReadonlyMap<string, SpanReplacement | null>,
): string => {
  let next = rewriteBlockRefs(content, fromId, intoId)
  for (const [fromAlias, replacement] of aliasReplacements) {
    if (replacement === null) continue
    next = rewriteWikilinks(next, fromAlias, replacement.text,
      {skipEmbeds: replacement.toTargetId !== null})
  }
  return next
}

const retargetSource = async (
  ctx: SameTxCtx,
  sourceId: string,
  event: CoreBlockMergedEvent,
  aliasReplacements: ReadonlyMap<string, SpanReplacement | null>,
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

  const nextContent = retargetReferenceContent(
    current.content,
    event.fromId,
    event.intoId,
    aliasReplacements,
  )
  // A pinned replacement steps over `![[alias]]` page embeds, so an alias
  // can still have a live span after its own rewrite ran — while
  // `normalizeReferences` gives every occurrence ONE shared entry.
  // Retarget that entry outright and the surviving embed vanishes from
  // `block_references` until the async re-parse rebuilds it. Same
  // compensation the rename path makes (`applyRefRewrites`).
  const remaining = new Set(parseReferences(nextContent).map(mark => mark.alias))
  const retainedAliases = new Set(
    [...aliasReplacements]
      .filter(([alias, replacement]) =>
        replacement !== null && replacement.toTargetId !== null && remaining.has(alias))
      .map(([alias]) => alias),
  )
  const nextReferences = retargetReferences(
    current.references, event.fromId, event.intoId,
    aliasReplacements, retainedAliases, retargetableFields,
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
