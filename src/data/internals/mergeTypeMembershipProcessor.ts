/**
 * Same-tx processor: when two blocks merge, move every member block's TYPE
 * MEMBERSHIP off the tombstoned `from` and onto the survivor.
 *
 * Merging two type-definition pages (the alias-collision "Merge into…" flow is
 * the easy way to get there) tombstones `from`, but every block previously
 * tagged with it still carries `from`'s id in its `types` list. That token
 * resolves through nothing afterwards — `blockIdByTypeId` only ever binds ids
 * of LIVE definition rows — so the blocks are silently un-typed: no chip, no
 * lifted properties, absent from every by-type query. Nothing repairs it later,
 * because `types` is independent stored state, not a derived mirror: the `#type`
 * gesture writes the property and deliberately leaves content alone
 * (`plugins/supertags/codeMirrorExtensions.ts`, `applyTag`), and the only other
 * writers are the explicit `TypeTagger` entry points.
 *
 * Why this is NOT part of `references.retargetMergedBlockReferences`, which
 * already retargets ref/refList property VALUES across a merge:
 *
 *  - `types` holds type IDS, not block ids. For every seeded type the token is
 *    a stable short string (`page`, `todo`, …) that must resolve with no backing
 *    block at all (`buildUnboundTypes`), and a seed's `block-type:type-id` claim
 *    deliberately breaks the block-id = type-id equality that user rows keep.
 *    So `typesProp` is not a `refList` and must not become one: a ref codec
 *    would assert an equality the model treats as a convention, project
 *    `block_references` rows onto targets like `todo` that are not blocks, and
 *    duplicate the membership index `block_types` already maintains.
 *  - discovery differs, which is the load-bearing half. That processor visits
 *    only sources the `block_references` index names (plus the merge target).
 *    A tagged block has no reference edge to its type — `types` is not
 *    projected, and the tag gesture writes no wikilink — so no
 *    field-eligibility change there could ever reach it. Membership has its own
 *    trigger-maintained index, and this is the processor that reads it.
 *
 * Kernel rather than a plugin: `typesProp`, `block_types` and `mergeBlocksInTx`
 * are all kernel, and membership must not be left dangling because a plugin
 * happens to be toggled off.
 */

import {
  CORE_BLOCK_MERGED_EVENT,
  defineSameTxProcessor,
  type AnySameTxProcessor,
  type CoreBlockMergedEvent,
  type SameTxCtx,
} from '@/data/api'
import { setBlockTypesInProperties, typesProp } from '@/data/properties'
import { typeMembershipTokenFor } from '@/data/typeDefinitionMetadata'

export const RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR_NAME =
  'core.retargetMergedTypeMembership'

/** Members of the merged-away type, via the trigger-maintained membership index
 *  (`type, workspace_id` is its leading index). The table already excludes
 *  tombstoned rows (its update trigger re-inserts only `WHEN deleted = 0`), and
 *  `ctx.db` reads inside the tx — so `from`'s own rows are gone by the time this
 *  runs and a self-tagged `from` can't come back as its own member. The `blocks`
 *  join is kept for the `deleted` re-check and a stable order. */
const SELECT_TYPE_MEMBER_IDS_SQL = `
  SELECT bt.block_id AS id
  FROM block_types bt
  JOIN blocks b
    ON b.id = bt.block_id
   AND b.workspace_id = bt.workspace_id
  WHERE bt.type = ?
    AND bt.workspace_id = ?
    AND b.deleted = 0
  ORDER BY b.created_at, b.id
`

/** `unchanged` — this cell doesn't name the merged-away type; `rewritten` —
 *  `value` is the new raw cell; `undecodable` — the cell names it but its shape
 *  makes an in-tx retarget impossible (see `rewriteTypeToken`). */
type TypeCellRewrite =
  | {outcome: 'unchanged'}
  | {outcome: 'rewritten'; value: readonly string[]}
  | {outcome: 'undecodable'}

/** Rewrite `fromToken` → `intoToken` inside a `types` cell's RAW encoded value,
 *  the way `mergeRetargetProcessor`'s `rewriteRefValue` handles a ref cell: on
 *  the raw value, so a malformed cell can be RECOGNIZED instead of throwing a
 *  `CodecError` that would roll back the user's whole merge over one unrelated
 *  bad row.
 *
 *  Only a well-formed `string[]` cell is retargeted. A malformed one is
 *  reachable here even though no LOCAL write path can produce it — typeify
 *  decodes `types` on every local properties write and throws — because a
 *  SYNC-APPLIED row bypasses the same-tx pass while the `block_types` triggers
 *  still index it. Notably `json_each(properties_json, '$.types')` over a SCALAR
 *  yields that scalar, so even `types: "<fromId>"` is indexed as a real
 *  membership and arrives here.
 *
 *  Such a row is left strictly ALONE, and the reason is not squeamishness about
 *  editing malformed data: it CANNOT be retargeted from inside this tx at all.
 *  Any write dirties the row for typeify's `rerunOnDirtyRows` pass, and that
 *  re-run decodes the row's BEFORE snapshot — the malformed value, whatever we
 *  wrote over it — so it throws and aborts the merge either way. Skipping keeps
 *  the merge working; the row's stale token stays visible to the same audit
 *  query that finds every other dangling token, and is repairable outside a
 *  merge tx. (Root cause worth fixing separately: unlike `getAliases`,
 *  `getBlockTypes` has no malformed-value tolerance, so one bad synced `types`
 *  cell bricks its row against every local properties write.)
 *
 *  Deliberately NOT sharing `projectedIdOf`'s trim: a ref cell tolerates
 *  whitespace padding around an id, but a membership token is compared verbatim
 *  by `block_types`, `getBlockTypes` and every by-type query, so `' x'` and `'x'`
 *  are genuinely different tokens and trimming would retarget a token that was
 *  never a member.
 *
 *  A rewrite that collides with a token already in the list dedupes to one
 *  entry (a block tagged with BOTH types keeps a single tag afterwards) —
 *  positionally, the earlier slot wins. */
const rewriteTypeToken = (
  raw: unknown,
  fromToken: string,
  intoToken: string,
): TypeCellRewrite => {
  const cell = Array.isArray(raw) ? raw : [raw]
  // Scanned in full before deciding, so a malformed cell that never named the
  // merged-away type reads as `unchanged` — nothing to do, nothing to warn about.
  let changed = false
  let decodable = Array.isArray(raw)
  const next: string[] = []
  const seen = new Set<string>()
  for (const el of cell) {
    if (typeof el !== 'string') { decodable = false; continue }
    const mapped = el === fromToken ? (changed = true, intoToken) : el
    if (seen.has(mapped)) continue
    seen.add(mapped)
    next.push(mapped)
  }
  if (!changed) return {outcome: 'unchanged'}
  return decodable ? {outcome: 'rewritten', value: next} : {outcome: 'undecodable'}
}

const retargetTypeMembership = async (
  event: CoreBlockMergedEvent,
  ctx: SameTxCtx,
): Promise<void> => {
  const into = await ctx.tx.get(event.intoId)
  if (into === null || into.deleted) return
  // The token the survivor's type is tagged under, via the SAME §9 claim rule
  // the registry publishes by, so the tag a merge writes is byte-equal to the
  // one `blockIdByTypeId` will bind.
  //
  // For every case the tests can drive this is the survivor's block id: user
  // types tag under their block id, and a merge that mutates a valid SEEDED
  // definition's bag (or tombstones it) is rejected earlier by
  // `assertNoSeedDefinitionWrites`. Going through the shared helper rather than
  // hardcoding `event.intoId` is therefore defence in depth — it is right if a
  // seeded survivor ever does come through here (its claimed `person` must not
  // be written as the seed block's uuid), and it costs nothing. The claim rule
  // itself is pinned by `typeDefinitionMetadata.test.ts`.
  //
  // When the survivor is NOT a type definition at all, the same helper yields
  // its block id, and members are retargeted onto it rather than having the tag
  // dropped. Dropping is destructive and unrecoverable; a token naming a live
  // block is undoable with the merge, diagnosable, and becomes real membership
  // again the moment that block is made a type — the same stance the reference
  // retarget takes when it moves a ref value regardless of the target's shape.
  const intoToken = typeMembershipTokenFor(into)
  // Degenerate no-op guard, not a pinned behavior: a survivor claiming the
  // merged-away id as its own type id would make every rewrite below identity.
  if (intoToken === event.fromId) return

  const members = await ctx.db.getAll<{id: string}>(
    SELECT_TYPE_MEMBER_IDS_SQL,
    [event.fromId, event.workspaceId],
  )
  for (const {id} of members) {
    const row = await ctx.tx.get(id)
    if (row === null || row.deleted) continue
    const rewrite = rewriteTypeToken(
      row.properties[typesProp.name], event.fromId, intoToken)
    if (rewrite.outcome === 'unchanged') continue
    if (rewrite.outcome === 'undecodable') {
      console.warn(
        `[${RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR_NAME}] block ${id} still tags the ` +
        `merged-away type ${event.fromId}, but its "types" cell is not a string list; ` +
        'left as-is — retargeting it would abort the merge (see rewriteTypeToken)',
      )
      continue
    }
    // `skipMetadata: true`, matching the reference retarget: following a merge
    // is derived bookkeeping, so it must not float every member into "recent"
    // or rewrite its "edited by". `updatedAt` still advances — `properties_json`
    // is synced, so the change needs a new row version to survive a peer's LWW.
    await ctx.tx.update(id, {
      properties: setBlockTypesInProperties(row.properties, rewrite.value),
    }, {skipMetadata: true})
  }
}

export const RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR = defineSameTxProcessor({
  name: RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR_NAME,
  watches: {kind: 'event', events: [CORE_BLOCK_MERGED_EVENT]},
  apply: async (event, ctx) => {
    for (const emitted of event.emittedEvents) {
      await retargetTypeMembership(emitted.payload as CoreBlockMergedEvent, ctx)
    }
  },
})

export const MERGE_TYPE_MEMBERSHIP_KERNEL_PROCESSORS: ReadonlyArray<AnySameTxProcessor> = [
  RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR,
]
