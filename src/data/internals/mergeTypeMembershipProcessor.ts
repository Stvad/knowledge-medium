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
  type BlockData,
  type CoreBlockMergedEvent,
  type SameTxCtx,
} from '@/data/api'
import { BLOCK_TYPE_TYPE } from '@/data/blockTypes'
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

/** Members whose row is TOMBSTONED, which `block_types` structurally cannot see
 *  (its update trigger re-inserts only `WHEN deleted = 0`). Their stored token
 *  still names the merged-away type, so restoring such a block after the merge
 *  would resurrect it silently un-typed — the exact damage this processor
 *  exists to prevent, just deferred to whenever the user hits undo or runs a
 *  restore.
 *
 *  Worth diverging from `mergeRetargetProcessor` here, which deliberately skips
 *  deleted sources: a restored block's REFERENCES are re-derived from its
 *  content by `parseReferences` on the next write, so skipping them costs
 *  nothing. Membership has no such re-derivation — `types` is stored state, and
 *  a token lost here is lost for good.
 *
 *  Matched with `LIKE` over the raw JSON rather than `json_each`, because
 *  `json_each` THROWS on a malformed `properties_json`, and one corrupt
 *  unrelated tombstone must not abort the user's merge. The `LIKE` is only a
 *  prefilter — it can match the id anywhere in the bag — so every hit is
 *  re-checked by `rewriteTypeToken` against the real `types` cell.
 *
 *  Unindexable by construction (a leading-wildcard `LIKE`), so this is a scan of
 *  the workspace's tombstones. It is gated at the call site on the merged-away
 *  block actually being a type definition, which makes it rare enough to pay
 *  for: ordinary block merges never reach it. */
const SELECT_DELETED_TYPE_MEMBER_IDS_SQL = `
  SELECT id
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 1
    AND properties_json LIKE ?
  ORDER BY created_at, id
`

/** Follow `fromId` through every merge THIS tx emitted, to the block that
 *  actually survives it.
 *
 *  A composed mutator can merge `A → B` and then `B → C` in one transaction.
 *  Processors run after the whole user fn, so by the time the `A → B` event is
 *  handled, `B` is already a tombstone: retargeting onto it would move `A`'s
 *  members onto a dead block, and bailing (the previous behavior) left them on
 *  the dead `A`. Both are the silent un-typing this processor exists to stop, so
 *  resolve the chain and land them on `C`.
 *
 *  Returns `null` for a cycle (`A → B`, `B → A` in one tx — degenerate, but a
 *  `while` here must not be able to spin), letting the caller fall back to the
 *  event's own destination. */
const resolveTerminalDestination = (
  fromId: string,
  mergeMap: ReadonlyMap<string, string>,
): string | null => {
  const seen = new Set<string>([fromId])
  let current = mergeMap.get(fromId)
  while (current !== undefined) {
    if (seen.has(current)) return null
    seen.add(current)
    const next = mergeMap.get(current)
    if (next === undefined) return current
    current = next
  }
  return null
}

/** A row's `types` tokens when the cell is WELL-FORMED, else `null`.
 *
 *  Two requirements that pull in opposite directions, and conflating them was a
 *  real bug:
 *
 *   - Don't THROW. `getBlockTypes`/`hasBlockType` throw on a malformed cell
 *     (unlike `getAliases`, which has exactly this tolerance), so deciding the
 *     source gate with those would roll back a merge whose SOURCE carries a
 *     malformed synced cell — while this same processor deliberately tolerates
 *     that shape on every MEMBER row.
 *   - Don't ACCEPT. A malformed cell is not evidence of anything. Reading
 *     `types: "block-type"` (a scalar — the sync-applied shape) as the list
 *     `["block-type"]` made a malformed ordinary block pass the ownership gate
 *     that exists precisely to stop a non-definition from mass-retagging a
 *     type's members. The codec and the type-definition registry both REJECT
 *     that row as a type; this must agree with them, not out-guess them.
 *
 *  So: tolerate the decode failure, and treat it as NON-owning. `null` is the
 *  distinction — "this cell says nothing" is not "this cell says no tokens".
 *
 *  (The asymmetry in `getBlockTypes` is worth closing at the source; until it
 *  is, this is the local defence.) */
const wellFormedTypeTokens = (row: BlockData): readonly string[] | null => {
  const raw = row.properties[typesProp.name]
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  return raw.every((el): el is string => typeof el === 'string')
    ? (raw as readonly string[])
    : null
}

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
  mergeMap: ReadonlyMap<string, string>,
  ctx: SameTxCtx,
): Promise<void> => {
  // The event's own `intoId` is only the IMMEDIATE destination; in a chained
  // merge it is itself a tombstone by now. See `resolveTerminalDestination`.
  const destinationId = resolveTerminalDestination(event.fromId, mergeMap) ?? event.intoId
  const into = await ctx.tx.get(destinationId)
  // A destination still deleted after chain resolution was deleted outright
  // rather than merged onward, so there is nowhere better to point: leave the
  // members alone rather than moving them from one tombstone to another.
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

  // The merged-away block must actually BE the type definition that owns these
  // memberships. `bt.type = event.fromId` alone does not prove that: a
  // membership token is any string, block ids are any string, and a seeded type
  // (`todo`) needs no backing block at its token — so an ordinary block that
  // merely HAPPENS to carry the id `todo` (an import minting its own ids is the
  // realistic route) would match every member of the seeded Todo type, and
  // merging that unrelated block would retag all of them onto its survivor.
  //
  // Reading `from` through `tx.get` still works — it is soft-deleted, bag
  // intact. Gating here rather than at the sweep also keeps an ordinary block
  // merge off BOTH queries.
  //
  // The trade, stated plainly: a definition row that was stripped of its
  // `block-type` tag before being merged no longer looks like a type here, so
  // its members are not retargeted. That is the safe direction — they stay
  // visible to the audit query and are repairable out of band, whereas a false
  // POSITIVE silently mass-retags an entire seeded type.
  const from = await ctx.tx.get(event.fromId)
  if (from === null) return
  const fromTokens = wellFormedTypeTokens(from)
  if (fromTokens === null || !fromTokens.includes(BLOCK_TYPE_TYPE)) return

  const members = await ctx.db.getAll<{id: string}>(
    SELECT_TYPE_MEMBER_IDS_SQL,
    [event.fromId, event.workspaceId],
  )
  // Tombstoned members are invisible to that index; sweep for them separately.
  members.push(...await ctx.db.getAll<{id: string}>(
    SELECT_DELETED_TYPE_MEMBER_IDS_SQL,
    [event.workspaceId, `%${JSON.stringify(event.fromId)}%`],
  ))
  for (const {id} of members) {
    const row = await ctx.tx.get(id)
    // Deliberately NOT skipping tombstones — see
    // `SELECT_DELETED_TYPE_MEMBER_IDS_SQL`. Rewriting a tombstone's bag does not
    // resurrect it (`deleted` is untouched); it just means the row carries a
    // live token if it is ever restored.
    if (row === null) continue
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
    const payloads = event.emittedEvents.map(e => e.payload as CoreBlockMergedEvent)
    // Every merge this tx performed, so each event can resolve past the ones
    // that ran after it. Built over ALL payloads before any is processed —
    // the chain is only visible from the whole set.
    const mergeMap = new Map(payloads.map(p => [p.fromId, p.intoId]))
    for (const payload of payloads) {
      // Sequential, and each iteration re-reads its members through `tx.get`:
      // a block tagged with two of this tx's merged-away types therefore picks
      // up both rewrites instead of the second clobbering the first.
      await retargetTypeMembership(payload, mergeMap, ctx)
    }
  },
})

export const MERGE_TYPE_MEMBERSHIP_KERNEL_PROCESSORS: ReadonlyArray<AnySameTxProcessor> = [
  RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR,
]
