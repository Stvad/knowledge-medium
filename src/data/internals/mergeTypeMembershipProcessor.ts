/**
 * Same-tx processor: when blocks are folded together, move each member block's
 * TYPE MEMBERSHIP off the tombstoned source and onto the survivor. Without it a
 * merged-away type definition leaves its members carrying a token that resolves
 * through nothing — silently un-typed, and never repaired, because `types` is
 * stored state rather than a mirror of content (the `#type` gesture writes only
 * the property).
 *
 * Two reasons this is not part of `references.retargetMergedBlockReferences`,
 * both of which also rule out the tempting refactor of making `typesProp` a
 * `refList` so that processor covers it:
 *  - `types` holds type IDS, not block ids. A seeded type's token is a short
 *    string that must resolve with NO backing block (`buildUnboundTypes`), so a
 *    ref codec would assert an equality the model treats as a convention and
 *    project reference rows onto targets that are not blocks.
 *  - a tagged block has no reference edge to its type, so that processor's
 *    `block_references` discovery can never reach it. Membership has its own
 *    trigger-maintained index (`block_types`), which is what this reads.
 *
 * Kernel, not a plugin: membership must not dangle because a plugin is off.
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

/** Live members of the merged-away type. `block_types` excludes tombstoned rows
 *  by construction, which is why the tombstone sweep below exists separately. */
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

/** Tombstoned members, which `block_types` cannot see. Skipping them (as
 *  `mergeRetargetProcessor` does for deleted sources) is safe for references,
 *  which re-derive from content on restore; membership has no such
 *  re-derivation, so a token left here is wrong forever once the block is
 *  restored.
 *
 *  `LIKE` rather than `json_each`, which THROWS on a malformed
 *  `properties_json` — one corrupt unrelated tombstone must not abort the
 *  merge. It is only a prefilter (it matches the id anywhere in the bag), so
 *  every hit is re-checked against the real cell by `rewriteTypeToken`.
 *
 *  Unindexable, so this scans the workspace's tombstones; the call site gates it
 *  on the source really being a type definition to keep it off ordinary merges. */
const SELECT_DELETED_TYPE_MEMBER_IDS_SQL = `
  SELECT id
  FROM blocks
  WHERE workspace_id = ?
    AND deleted = 1
    AND properties_json LIKE ?
  ORDER BY created_at, id
`

/** Follow `fromId` through every merge THIS tx emitted, to the block that
 *  actually survives it. A tx can fold `A → B` and `B → C`, and processors run
 *  after the whole user fn — so an event's own `intoId` may already be a
 *  tombstone. `null` on a cycle, so the loop cannot spin. */
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

/** A row's `types` tokens when the cell is well-formed, else `null` — "says
 *  nothing", which is not "says no tokens".
 *
 *  The obvious tolerant decode gets one half wrong. It must not THROW
 *  (`getBlockTypes` does, so a malformed synced cell would roll back the merge)
 *  and must not ACCEPT (reading the scalar `types: "block-type"` as a one-element
 *  list would let a malformed ordinary block pass the ownership gate, which the
 *  codec and registry both refuse). */
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

/** Rewrite `fromToken` → `intoToken` in a `types` cell's RAW value (as
 *  `rewriteRefValue` does for ref cells), so a malformed cell is recognized
 *  rather than throwing a `CodecError` that would roll back the merge.
 *
 *  A malformed cell is left untouched because it CANNOT be retargeted in this
 *  tx: any write dirties the row for typeify's `rerunOnDirtyRows` pass, which
 *  decodes the BEFORE snapshot — still malformed — and throws. Such cells reach
 *  here from sync-applied rows, which bypass the same-tx pass while the
 *  `block_types` triggers still index them.
 *
 *  No `projectedIdOf` trim: membership tokens are compared verbatim everywhere,
 *  so `' x'` and `'x'` are different tokens and trimming would retarget one that
 *  was never a member. A rewrite colliding with an existing token dedupes. */
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
  const destinationId = resolveTerminalDestination(event.fromId, mergeMap) ?? event.intoId
  const into = await ctx.tx.get(destinationId)
  // Still deleted after chain resolution = deleted outright, not merged onward.
  // Nowhere better to point, so leave the members rather than moving them to
  // another tombstone.
  if (into === null || into.deleted) return
  // The §9 claim rule the registry publishes by, so the tag written here is
  // byte-equal to the one `blockIdByTypeId` binds. Defence in depth today —
  // every reachable survivor tags under its block id — but right if a seeded
  // survivor ever arrives. When the survivor is not a type definition at all
  // this yields its block id, and members follow it rather than losing the tag:
  // dropping is unrecoverable, while a token naming a live block is undoable
  // with the merge and becomes real membership if that block is made a type.
  const intoToken = typeMembershipTokenFor(into)
  if (intoToken === event.fromId) return

  // The source must really BE the definition that owns these memberships:
  // `bt.type = fromId` does not prove it, since tokens and block ids are both
  // arbitrary strings and a seeded type needs no backing block at its token. An
  // ordinary block carrying the id `todo` would otherwise match every member of
  // the seeded Todo type and retag them all.
  //
  // Accepted trade: a definition stripped of its `block-type` tag before being
  // merged no longer looks like one here, so its members are left for the audit
  // query — the safe direction, since a false positive mass-retags a whole type.
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
    // Tombstones are deliberately included: rewriting the bag does not
    // resurrect them, it just means they carry a live token if restored.
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
    // `skipMetadata`: derived bookkeeping must not float every member into
    // "recent" or rewrite its "edited by". `updatedAt` still advances, which a
    // synced column needs to survive a peer's LWW.
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
    // Built over ALL payloads first: a chain is only visible from the whole set.
    const mergeMap = new Map(payloads.map(p => [p.fromId, p.intoId]))
    // Sequential is load-bearing. `foldBlocksInTx` emits one event per source,
    // so a block tagged with two of them is rewritten twice; each pass re-reads
    // through `tx.get`, and running these concurrently makes the second clobber
    // the first (pinned by the "BOTH … types" tests).
    for (const payload of payloads) {
      await retargetTypeMembership(payload, mergeMap, ctx)
    }
  },
})

export const MERGE_TYPE_MEMBERSHIP_KERNEL_PROCESSORS: ReadonlyArray<AnySameTxProcessor> = [
  RETARGET_MERGED_TYPE_MEMBERSHIP_PROCESSOR,
]
