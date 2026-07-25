/**
 * Alias-rename backlink rewriter (spec: docs/alias-rename-cases.html
 * — rename ladder).
 *
 * Watches alias-property diffs on `blocks`. For each removed alias α
 * with live backlinks (found via the `block_references` projection):
 *
 *   1. 1-for-1 swap (|removed| = |added| = 1) — R1, R2, A1-cascade,
 *      AR1-cascade: rewrite `[[α]] → [[new]]` in source content.
 *   2. Anything else with backlinks (R4, R5, R6, R7, A2-cascade):
 *      rewrite `[[α]] → [α](((target-id)))` (aliased blockref).
 *      Preserves the display text the source author wrote; doesn't
 *      depend on what's left in `aliases`.
 *   3. Pure add (no removed aliases) — R3: no-op.
 *
 * Lives next to `parseReferencesProcessor` in the references plugin
 * because it needs the `block_references` projection to find source
 * blocks.
 *
 * Two-phase shape mirrors parseReferences: read phase outside any tx
 * builds a plan describing per-source rewrites AND records the source
 * content observed at decision time. Write phase opens one tx,
 * re-reads source content via `tx.get`, and skips the source entirely
 * if content has changed (later user edit wins — see `applyPlan`).
 * Otherwise applies the rewrites via parser-aware span splicing
 * (`rewriteWikilinks`) AND surgically swaps the matching `references`
 * entries in the same tx so the `block_references` trigger refreshes
 * in lockstep. Without that, a second rapid rename's SELECT would
 * race the separate parseReferences processor and miss the source —
 * leaving the backlink stuck on an alias the target no longer carries.
 *
 * Idempotency: the rewrite produces source content that no longer
 * contains `[[α]]`, so a second pass over the same source content is
 * a no-op (no matching span). Rename doesn't re-fire on the source
 * content edit because its watcher is `properties`-only.
 */

import {
  ChangeScope,
  definePostCommitProcessor,
  normalizeReferences,
  type AnyPostCommitProcessor,
  type BlockData,
  type BlockReference,
  type CommittedEvent,
  type ProcessorCtx,
  type Tx,
} from '@/data/api'
import { aliasesProp } from '@/data/properties'
import { readIsChildBackedWorkspace } from '@/data/workspaceSchema'
import {
  ALIAS_SEAT_PROBE_SLOTS,
  computeAliasSeatId,
  generatedSeatFieldIds,
  matchesAliasSeatSeed,
} from '@/data/targets'
import { rewriteWikilinks, type SpanReplacement } from './referenceParser.ts'
import { preferredSpanReplacement } from './spanReplacement.ts'

export const RENAME_BACKLINKS_PROCESSOR = 'references.renameBacklinks'

/** The seat-classification columns, projected identically by both
 *  queries below so one predicate can read either. `blockingChildren`
 *  subtracts the seat's own generated property children — the two
 *  `generatedSeatFieldIds` bind params — which is what keeps the
 *  children signal from inverting after the workspace flip. In an
 *  UN-flipped workspace the caller passes ids that match nothing, so any
 *  live child blocks: there, a `reference_target_id` match under a seat
 *  is by construction user-authored content, not machinery. */
const SEAT_COLUMNS_SQL = (t: string, generatedFieldIdCount: number) => `
         ${t}.id AS targetId,
         ${t}.content AS targetContent,
         ${t}.properties_json AS targetProperties,
         ${t}.created_at AS targetCreatedAt,
         ${t}.user_updated_at AS targetUserUpdatedAt,
         EXISTS(
           SELECT 1 FROM blocks child
           WHERE child.parent_id = ${t}.id
             AND child.deleted = 0
             AND (child.reference_target_id IS NULL
                  OR child.reference_target_id NOT IN (${
                    Array.from({length: generatedFieldIdCount}, () => '?').join(', ')
                  }))
         ) AS targetBlockingChildren`

interface SeatCandidateRow {
  targetId: string
  targetContent: string
  targetProperties: string
  targetCreatedAt: number
  targetUserUpdatedAt: number | null
  targetBlockingChildren: 0 | 1
}

/** When this row was last MATERIALIZED as a seat. `created_at` alone is
 *  wrong: `resolveAliasSeatId` deliberately reuses a slot holding a
 *  pristine tombstone (so a hot name doesn't burn a fresh slot every
 *  reap cycle), and `tx.restore` refreshes `user_updated_at` but never
 *  `created_at` — that column is immutable by contract. A restored seat
 *  would therefore read as ancient and be rejected, skipping the rename
 *  entirely and stranding the span. Both mint paths stamp
 *  `user_updated_at`, so the max covers fresh insert and restore alike;
 *  the shape/slot/children signals already exclude a seat a user
 *  touched, so the looser stamp doesn't widen the exemption. */
const seatMaterializedAt = (row: SeatCandidateRow): number =>
  Math.max(row.targetCreatedAt, row.targetUserUpdatedAt ?? 0)

/** Wall-clock floor for "materialized after the commit we are reacting
 *  to". NOT `userUpdatedAt` alone: that is the DISPLAY stamp, and
 *  `metadataPatch` leaves it untouched on a `{skipMetadata}` write while
 *  still advancing `updatedAt`. Several paths write the alias cell that
 *  way — `core.projectPropertyChildren` (the post-flip rename gesture,
 *  where a user edits the `alias::` field row and the projection writes
 *  the parent bag), `rekeyParentPropertyCell`, `alias.sync`, the merge
 *  retarget — so the display stamp can be days stale. Stale means a
 *  LOWER floor, which is the unsafe direction: an older pre-existing
 *  seat starts passing the recency gate and its backlinks get hijacked.
 *
 *  `updatedAt` is the row-version and always ratchets
 *  (`Math.max(now, before.updatedAt + 1)`); the `systemMint` 0-sentinel
 *  is insert-only, and a rename is always an UPDATE. Taking the max errs
 *  HIGH — a server-ratcheted version from sync can overshoot wall clock,
 *  which only makes us skip a rename. Fails closed. */
const renameCommitStamp = (after: BlockData): number =>
  Math.max(after.updatedAt, after.userUpdatedAt ?? 0)

/** Per-alias classification context, built once instead of per row.
 *  `slotIds` is the whole probe window precomputed — `isAliasSeatSlotId`
 *  is 64 uuidv5 hashes (~0.29ms) on a miss, and the alias-keyed
 *  enumeration made the row count workspace-wide, so calling it per row
 *  is O(rows x 64) hashing for an O(1) question. */
interface SeatClassificationCtx {
  slotIds: ReadonlySet<string>
  /** Wall-clock floor: a seat older than this predates the commit we're
   *  reacting to, so it is not this rename's window artifact. */
  mintedAfter: number
}

const seatClassificationCtx = (
  alias: string,
  workspaceId: string,
  mintedAfter: number,
): SeatClassificationCtx => {
  const slotIds = new Set<string>()
  for (let i = 0; i < ALIAS_SEAT_PROBE_SLOTS; i++) {
    slotIds.add(computeAliasSeatId(alias, workspaceId, i))
  }
  return {slotIds, mintedAfter}
}

/** Backlink sources for one removed alias — keyed on the ALIAS alone,
 *  with the target row joined so the caller can apply the
 *  claimant-or-provable-seat disjunction in JS (§11 group 2).
 *
 *  Keying on `(target_id, alias)` — as this did — silently skipped
 *  spans whose reference edge had already moved off the renaming
 *  claimant. That happens in the rename window: the rename case is
 *  necessarily outside the "rewrite content before alias surgery"
 *  ordering invariant (the rewrite CONSUMES the alias diff, and a
 *  synced-in rename arrives with the alias already moved), so a
 *  concurrent re-derive of `[[α]]` can bind the span to a freshly
 *  minted α-seat first. Such an edge matches the alias but not the
 *  target, and no later pass owns it — leaving a permanently
 *  seat-bound span. Enumerating by alias and filtering by target in
 *  JS lets those window-bound spans rewrite with the rest.
 *
 *  Rides `idx_block_references_ws_alias` (`localSchema.ts`), added with
 *  this query — no pre-existing index leads with `workspace_id`/`alias`,
 *  so without it this is a full scan of every edge on the device.
 *
 *  `source_field = ''` restricts to CONTENT edges. Property-derived
 *  edges carry `alias === targetId` so they could only collide with a
 *  UUID-shaped alias, and `applyRefRewrites` skips them anyway — but
 *  enumerating them still costs a `tx.get` per bogus source.
 *
 *  `target.deleted = 0` keeps this no wider than the old key was. A
 *  tombstoned pristine seat would otherwise satisfy the disjunction and
 *  get its edges re-pointed — plausibly desirable (the seat is dead, so
 *  the span is stranded either way), but it is not what this change set
 *  out to do and nothing tests it. */
const selectBacklinkSourcesSql = (generatedFieldIdCount: number) => `
  SELECT br.source_id AS sourceId,
         source.content AS sourceContent,
         br.target_id AS targetId,
         ${SEAT_COLUMNS_SQL('target', generatedFieldIdCount)}
  FROM block_references br
  JOIN blocks source ON source.id = br.source_id
  JOIN blocks target ON target.id = br.target_id
  WHERE br.workspace_id = ?
    AND br.alias = ?
    AND br.source_field = ''
    AND source.deleted = 0
    AND target.deleted = 0
`

interface BacklinkSourceRow extends SeatCandidateRow {
  sourceId: string
  sourceContent: string
}

/** Live claimants of `alias`. Deliberately NOT `tx.aliasLookup` /
 *  `SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL`: those return the single
 *  oldest claimant, and the uniqueness trigger only fires for local user
 *  txs (`clientSchema.ts`), so sync-applied rows can leave several live
 *  blocks claiming one alias. We need to classify ALL of them. */
const selectAliasClaimantsSql = (generatedFieldIdCount: number) => `
  SELECT ${SEAT_COLUMNS_SQL('b', generatedFieldIdCount)}
  FROM block_aliases ba
  JOIN blocks b ON b.id = ba.block_id
  WHERE ba.workspace_id = ?
    AND ba.alias = ?
    AND b.deleted = 0
`

/** Is `row` a machine-minted, never-touched seat for `alias` that this
 *  rename's own window created?
 *
 *  FOUR signals, none sufficient alone.
 *
 *  SHAPE (`aliasSeatSeed`) says nothing drifted — no rename, no user
 *  property, no extra alias — but quick-find's create-page writes
 *  exactly that shape too. SLOT ID separates them: only
 *  `ensureAliasTarget` mints rows at `computeAliasSeatId(alias, ws, i)`,
 *  so a user's page carrying the same shape still has a random uuid.
 *
 *  CHILDREN mean a user treated it as a real page — but only after
 *  subtracting the seat's OWN generated property children, and only in a
 *  flipped workspace. Post-flip `ensureAliasTarget`'s two `setProperty`
 *  calls route through `writePropertyValueChild`, so every seat is born
 *  with children: a bare "has live children?" test doesn't merely fail to
 *  refine there, it INVERTS — no seat is ever recognized, the window
 *  disjunction below no-ops, and worse, the seat then counts as a real
 *  claimant and suppresses the rewrite entirely. `generatedSeatFieldIds`
 *  is the same subtraction the reaper does (`referencesProcessor.ts`).
 *
 *  RECENCY is the one that keeps this honest. The other three describe a
 *  pristine seat, not a seat THIS rename produced, and a seat that has
 *  owned α since long before the renaming block existed satisfies them
 *  identically. Exempting that one from "claimant" — and then following
 *  its edges — re-points every `[[α]]` bound to it onto a block that
 *  never owned the name here. Reachable without any race: the alias
 *  uniqueness trigger is skipped for sync-applied rows, so a synced
 *  block can co-claim an alias a local seat already holds, and releasing
 *  it would hijack the seat's backlinks. A window seat is materialized
 *  AFTER the commit we are reacting to, so it cannot predate it.
 *
 *  Both sides of that comparison are picked to fail CLOSED — too-recent
 *  a floor, or too-old a seat, means "treat it as a real claimant and
 *  skip", which leaves `[[α]]` late-binding to the seat. The opposite
 *  error is an irreversible content splice. See `seatMaterializedAt`
 *  for the seat side and `renameCommitStamp` for the floor.
 *
 *  This is a heuristic on timestamps, not a structural signal: nothing
 *  in current state records WHICH rename minted a seat. It is bounded
 *  by failing closed, but if it keeps springing leaks the honest answer is to
 *  drop the seat leg entirely (the window span then stays bound to the
 *  seat — a working link to a stub, and the pre-existing behaviour). */
const isWindowMintedAliasSeat = (
  row: SeatCandidateRow,
  alias: string,
  ctx: SeatClassificationCtx,
): boolean => {
  if (row.targetContent !== alias) return false
  if (seatMaterializedAt(row) < ctx.mintedAfter) return false
  if (row.targetBlockingChildren === 1) return false
  if (!ctx.slotIds.has(row.targetId)) return false
  let properties: Record<string, unknown>
  try {
    properties = JSON.parse(row.targetProperties) as Record<string, unknown>
  } catch {
    return false
  }
  return matchesAliasSeatSeed({content: row.targetContent, properties})
}

const decodeAliases = (block: BlockData): readonly string[] => {
  const encoded = block.properties[aliasesProp.name]
  if (encoded === undefined) return []
  try {
    return aliasesProp.codec.decode(encoded)
  } catch {
    return []
  }
}

/** Replacement form for a single removed alias α — the rename ladder,
 *  composed from the shared `preferredSpanReplacement` policy.
 *
 *  `null` means "leave every span for this alias alone": no rendering
 *  could carry the reference, so any rewrite would destroy the link
 *  outright. Already reported by the time it returns.
 *
 *  R1/R2/A1-cascade: a clean 1-for-1 swap keeps the late-binding
 *  wikilink form. Everything else (R4/R5/R6/R7, A2-cascade) — and a
 *  1-for-1 whose new alias isn't wikilink-safe — pins to the target,
 *  labelled with the REMOVED alias so the source author's display text
 *  survives.
 *
 *  NOT YET IMPLEMENTED (§11 group 2, tracked on #443): the doc's
 *  marked-row arm — "its lossy-name fallback for marked rows is
 *  canonical `::((A))`, never a pinned label". Nothing here consults
 *  `isFieldForm`, so a marked name row `::[[α]]` with a lossy label
 *  currently gets `::[sanitized](((A)))` plus a warning. That is still a
 *  recognized field row (the bit stamps for every marked form,
 *  aliased blockref included), so it degrades honestly rather than
 *  silently — but it is not the canonical form the doc specifies. */
export const replacementFor = (
  alias: string,
  removed: readonly string[],
  added: readonly string[],
  targetId: string,
): SpanReplacement | null => preferredSpanReplacement({
  wikilinkAlias: removed.length === 1 && added.length === 1 ? added[0] : null,
  pinLabel: alias,
  targetId,
  context: RENAME_BACKLINKS_PROCESSOR,
})

/** One rewrite operation applied to a single source. The target pair
 *  plus `refAlias` drive the inline references update: each content ref
 *  matching `(fromTargetId, alias, sourceField:'')` becomes
 *  `(toTargetId, refAlias, sourceField:'')`. Multiple rewrites per
 *  source accumulate when several aliases on the same target are
 *  removed in one commit. Order matters: applied in collection order. */
export interface Rewrite {
  alias: string
  replacement: string
  /** The edge's CURRENT target — what the stored `references` entry
   *  says today. Usually the renaming block; a window-bound span
   *  carries the α-seat instead. Matching key for the entry swap. */
  fromTargetId: string
  /** Where the replacement text points — always the renaming block. */
  toTargetId: string
  refAlias: string
  /** This alias's seat-slot window, carried so the write phase can
   *  re-assert the release without recomputing 64 uuidv5 hashes. */
  seatIds: ReadonlySet<string>
  /** True when `replacement` is the PINNED form `[label](((id)))`.
   *  Drives the embed guard at the splice — see `rewriteWikilinks`. */
  pinned: boolean
}

/** Per-source plan. Stores rewrites plus the source content observed
 *  during the read phase. Write phase re-reads the source via
 *  `tx.get`; if content has diverged at all, the rewrite is skipped
 *  entirely so the user's later edit wins strictly. Without this
 *  guard, a `[[α]]` the user typed in the race window between read
 *  and write would also be rewritten — they didn't exist at decision
 *  time and shouldn't be touched. */
interface SourcePlan {
  sourceId: string
  originalContent: string
  rewrites: Rewrite[]
}

/** Pull source plans for one target's alias diff and merge into the
 *  per-event `plansBySourceId` map. Reads via committed-state SQL —
 *  no tx open. */
const collectTargetPlans = async (
  ctx: ProcessorCtx,
  before: BlockData,
  after: BlockData,
  plansBySourceId: Map<string, SourcePlan>,
): Promise<void> => {
  const beforeAliases = decodeAliases(before)
  const afterAliases = decodeAliases(after)
  const removed = beforeAliases.filter(a => !afterAliases.includes(a))
  if (removed.length === 0) return
  const added = afterAliases.filter(a => !beforeAliases.includes(a))

  // Generated-children subtraction is FLIP-GATED, per
  // `generatedSeatFieldIds`' own contract: in an un-flipped workspace a
  // `reference_target_id` match under a seat is by construction
  // user-authored content (`core.deriveReferenceTarget` stamps the
  // column on a hand-written `::` row too), not machinery's to ignore.
  // Subtracting unconditionally would let a user who typed `alias:: …`
  // under a seat page have that page classified as pristine machinery.
  const generatedFieldIds = await readIsChildBackedWorkspace(ctx.db, after.workspaceId)
    ? [...generatedSeatFieldIds(after.workspaceId)]
    : []
  for (const alias of removed) {
    const seatCtx = seatClassificationCtx(alias, after.workspaceId, renameCommitStamp(after))
    // Consult α's POST-TX claimant before deciding anything (§11
    // group 2). A live claimant means α is not ours to re-key:
    //   - handoff — some other block owns the name now, so `[[α]]`
    //     already resolves where the author would expect. Rewriting
    //     it (to the new alias, or pinned to the block that just gave
    //     α up) would steal the span from its rightful target.
    //   - re-claim — a later tx put α back on this same block, so the
    //     removal we're reacting to no longer holds.
    // Only a genuine RELEASE falls through to the rename ladder. The one
    // claim that doesn't count is a seat THIS window minted: that's the
    // artifact this pass exists to rewrite past, not a successor to
    // defer to. Re-asserted inside the write tx (`applyPlan`), because
    // this read is outside any transaction.
    const claimants = await ctx.db.getAll<SeatCandidateRow>(
      selectAliasClaimantsSql(generatedFieldIds.length),
      [...generatedFieldIds, after.workspaceId, alias],
    )
    if (claimants.some(row => !isWindowMintedAliasSeat(row, alias, seatCtx))) {
      continue
    }

    const replacement = replacementFor(alias, removed, added, after.id)
    // No rendering could carry this span — leave every source alone
    // (already reported by `replacementFor`).
    if (replacement === null) continue
    const sources = await ctx.db.getAll<BacklinkSourceRow>(
      selectBacklinkSourcesSql(generatedFieldIds.length),
      [...generatedFieldIds, after.workspaceId, alias],
    )
    for (const row of sources) {
      // Target disjunction: the renaming claimant, or a window-minted
      // machine α-seat a concurrent re-derive bound the span to.
      // Anything else is a different block that happens to share the
      // alias text — not ours.
      if (row.targetId !== after.id
        && !isWindowMintedAliasSeat(row, alias, seatCtx)) continue
      // First sighting of this source pins `originalContent`. If a
      // later target rename hits the same source within this event,
      // both reads are inside the same committed snapshot so the
      // pinned value still matches what the second SELECT would see.
      let plan = plansBySourceId.get(row.sourceId)
      if (plan === undefined) {
        plan = {sourceId: row.sourceId, originalContent: row.sourceContent, rewrites: []}
        plansBySourceId.set(row.sourceId, plan)
      }
      plan.rewrites.push({
        alias,
        replacement: replacement.text,
        fromTargetId: row.targetId,
        toTargetId: replacement.toTargetId ?? after.id,
        refAlias: replacement.refAlias,
        seatIds: seatCtx.slotIds,
        pinned: replacement.toTargetId !== null,
      })
    }
  }
}

/** Apply rewrites to a source's `references` list. Content edges
 *  matching `(fromTargetId, oldAlias)` are re-pointed at
 *  `(toTargetId, refAlias)`. BOTH halves move: a window-bound span's
 *  edge names the α-seat while the replacement text pins to the
 *  renaming block, so swapping only the alias would leave the entry
 *  naming a target the content no longer references.
 *  Property-typed refs (`sourceField !== ''`) are untouched — wikilink
 *  rewrites never affect them. Returned list is run through
 *  `normalizeReferences` so duplicates introduced by the swap (e.g.
 *  source already had `[[β]]` before we rewrote `[[α]] → [[β]]`)
 *  collapse, and the on-disk JSON stays canonical. */
export const applyRefRewrites = (
  refs: ReadonlyArray<BlockReference>,
  rewrites: ReadonlyArray<Rewrite>,
): BlockReference[] => {
  if (rewrites.length === 0) return [...refs]
  // (fromTargetId, oldAlias) → (toTargetId, newRefAlias). Last-write-
  // wins across rewrites — mirrors the content rewrite order (each
  // `rewriteWikilinks` pass operates on the prior pass's output).
  const swaps = new Map<string, {id: string; alias: string}>()
  const key = (targetId: string, alias: string) => `${targetId}\u0000${alias}`
  for (const rw of rewrites) {
    swaps.set(key(rw.fromTargetId, rw.alias), {id: rw.toTargetId, alias: rw.refAlias})
  }
  const next: BlockReference[] = []
  for (const ref of refs) {
    const sourceField = ref.sourceField ?? ''
    if (sourceField !== '') { next.push(ref); continue }
    const swapped = swaps.get(key(ref.id, ref.alias))
    next.push(swapped === undefined ? ref : {...ref, id: swapped.id, alias: swapped.alias})
  }
  return normalizeReferences(next)
}

/** Re-assert, INSIDE the write tx, that every alias a plan rewrites is
 *  still unclaimed (or claimed only by a window seat).
 *
 *  The read-phase check is a committed-state read outside any
 *  transaction, and `serializeRename` only serializes rename against
 *  rename — sync materialization, the alias plugin and ordinary user
 *  writes all commit freely in the gap. `applyPlan`'s content guard is
 *  structurally blind to this: a third party claiming α doesn't touch
 *  the SOURCE, so the source's content is unchanged and the rewrite
 *  proceeds, pinning the span to the block that just gave the name up.
 *
 *  Uses `tx.aliasClaimants`, NOT `tx.aliasLookup`. The single-row form
 *  is `ORDER BY created_at LIMIT 1`, so when a window seat is OLDER than
 *  a claimant that landed in the gap — the normal ordering, since the
 *  competitor is newly created or newly synced — it returns the seat,
 *  the seat check passes, and the rewrite proceeds anyway. That is the
 *  very hijack this re-assert exists to stop, surviving in a narrower
 *  configuration. Every claimant has to be classified, exactly as the
 *  read phase does. (`block_aliases` IS reachable in-tx; the residual
 *  documented on the reaper is about `block_references`, which the `Tx`
 *  surface genuinely cannot read.)
 *
 *  Memoized per alias for the tx's lifetime: the answer depends only on
 *  `(workspaceId, alias)`, and `applyPlan` writes only `content` /
 *  `references`, never the `aliases` property, so `block_aliases` cannot
 *  change mid-tx. Without this the check ran once per rewrite PER
 *  SOURCE — hundreds of identical reads held under the write lock, where
 *  nothing else in the app can write. */
type ReleaseCache = Map<string, Promise<boolean>>

const aliasStillReleased = (
  tx: Tx,
  workspaceId: string,
  rewrite: Rewrite,
  cache: ReleaseCache,
): Promise<boolean> => {
  const key = `${workspaceId}\u0000${rewrite.alias}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const pending = (async () => {
    const claimants = await tx.aliasClaimants(rewrite.alias, workspaceId)
    // A gap-arriving claimant sitting at one of this alias's seat slots
    // is a fresh mint or a pristine-tombstone restore — machinery, not a
    // successor. Anything else vetoes. The shape checks the read phase
    // runs are deliberately skipped here: `Tx` returns whole blocks, and
    // re-deriving `matchesAliasSeatSeed` in-tx would gate a data-loss
    // guard on a stricter predicate than the hazard needs.
    return claimants.every(claimant => rewrite.seatIds.has(claimant.id))
  })()
  cache.set(key, pending)
  return pending
}

const applyPlan = async (
  tx: Tx,
  plan: SourcePlan,
  releaseCache: ReleaseCache,
): Promise<void> => {
  // Strict "later user edit wins": if source content has changed
  // between our read phase and this write tx, skip entirely. Without
  // this we'd also rewrite `[[α]]` spans the user typed in the race
  // window — they didn't exist when we decided to rewrite, and the
  // user's typing should take precedence. The cost: a single
  // unrelated keystroke to the source between event and apply will
  // cancel this source's rewrite (acceptable — the next deliberate
  // rename of α catches it, or the user reconciles manually).
  const current = await tx.get(plan.sourceId)
  if (current === null || current.deleted) return
  if (current.content !== plan.originalContent) return
  // Re-assert the release per alias, now under the write lock (see
  // `aliasStillReleased`). Drop just the rewrites whose alias got
  // claimed in the gap — the rest of the plan is still good.
  const live: Rewrite[] = []
  for (const rewrite of plan.rewrites) {
    if (await aliasStillReleased(tx, current.workspaceId, rewrite, releaseCache)) {
      live.push(rewrite)
    }
  }
  if (live.length === 0) return
  let nextContent = current.content
  for (const rewrite of live) {
    nextContent = rewriteWikilinks(
      nextContent, rewrite.alias, rewrite.replacement,
      // Pinned replacements only: see `rewriteWikilinks`' embed note.
      {skipEmbeds: rewrite.pinned},
    )
  }
  if (nextContent === current.content) return
  // Surgically swap the matching `references` entries in lockstep with
  // the content rewrite so the `block_references` trigger refreshes
  // the projection inside this same SQL tx. parseReferences will fire
  // on the content change and re-emit the same list (idempotent), but
  // by then the next rename's SELECT already sees the up-to-date
  // index — no race window.
  const nextRefs = applyRefRewrites(current.references, live)
  await tx.update(
    plan.sourceId,
    {content: nextContent, references: nextRefs},
    {skipMetadata: true},
  )
}

/** True iff the alias-encoded value differs between before/after.
 *  Cheap pre-filter on the properties-field watcher so we skip the
 *  per-row decode + SQL when the change was a non-alias property. */
const aliasFieldChanged = (before: BlockData, after: BlockData): boolean => {
  const b = before.properties[aliasesProp.name]
  const a = after.properties[aliasesProp.name]
  return JSON.stringify(b ?? null) !== JSON.stringify(a ?? null)
}

/** Process-wide FIFO queue for rename invocations.
 *
 *  Rapid back-to-back title edits (e.g. cmd-Z + retype, or two
 *  setContent calls in quick succession) produce one rename event
 *  per user tx. Each event reads `block_references` to find sources,
 *  then opens a writeTransaction to rewrite. The READ phase runs
 *  outside the tx (cheap, doesn't hold a writer slot) — which means
 *  rename-N+1's SELECT can race ahead of rename-N's write commit,
 *  miss the source, and leave the backlink stuck on an alias the
 *  target no longer carries.
 *
 *  SQLite serializes writeTransactions, so rename-N+1's tx waits for
 *  rename-N's tx to commit — but by then rename-N+1 has already
 *  taken its (stale) read snapshot. The serializer-at-write boundary
 *  is too late; we have to serialize the whole read-plan-write
 *  cycle. Module-level FIFO queue does that with one promise chain.
 *
 *  Cost: at most one rename runs at a time process-wide. Acceptable
 *  because rename is post-commit and not on the typing path; the
 *  alternative (in-tx SELECT, or per-source mutex keyed on resolved
 *  source ids that we don't know pre-read) is more complex for the
 *  same end-state.
 *
 *  Errors swallowed at the chain level (re-thrown to the original
 *  caller) so a single rename failure doesn't block subsequent
 *  renames. */
let renameQueue: Promise<void> = Promise.resolve()
const serializeRename = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = renameQueue.then(fn)
  // Continue the chain regardless of this fn's outcome — failures
  // are surfaced to the caller via the returned promise (which we
  // don't intercept), not the chain anchor.
  renameQueue = next.then(() => {}, () => {})
  return next
}

export const renameBacklinksProcessor = definePostCommitProcessor({
  name: RENAME_BACKLINKS_PROCESSOR,
  // Properties-only: alias diffs ride this field. parseReferences
  // watches content separately and refreshes the references column on
  // the rewrites we issue, closing the loop.
  watches: { kind: 'field', table: 'blocks', fields: ['properties'] },
  // Soft-deleted targets are skipped. The doc's sibling item — "the
  // delete flow triggers the release rewrite explicitly (a bare
  // tombstone leaves no properties diff)" — is deliberately NOT here:
  // it needs the definition-delete surface and a scope decision (§11
  // group 2 on #443, overlapping #383). Watching `deleted` from this
  // processor would generalize the release rewrite to every page
  // deletion, which is exactly the call that issue defers.
  apply: async (event: CommittedEvent<undefined>, ctx: ProcessorCtx) =>
    serializeRename(async () => {
      const plansBySourceId = new Map<string, SourcePlan>()
      for (const row of event.changedRows) {
        if (row.before === null || row.after === null) continue
        if (row.after.deleted) continue
        if (!aliasFieldChanged(row.before, row.after)) continue
        await collectTargetPlans(ctx, row.before, row.after, plansBySourceId)
      }
      if (plansBySourceId.size === 0) return

      await ctx.repo.tx(async tx => {
        const releaseCache: ReleaseCache = new Map()
        for (const plan of plansBySourceId.values()) {
          await applyPlan(tx, plan, releaseCache)
        }
      }, {
        scope: ChangeScope.References,
        description: `processor: ${RENAME_BACKLINKS_PROCESSOR}`,
      })
    }),
})

export const renamePostCommitProcessors: ReadonlyArray<AnyPostCommitProcessor> = [
  renameBacklinksProcessor,
]
