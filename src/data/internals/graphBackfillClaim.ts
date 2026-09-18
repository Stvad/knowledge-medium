/**
 * The production `BackfillCompletionClaim`: block-backed, synced, one claim
 * per (workspace, backfill).
 *
 * A workspace backfill repairs SOURCE-OF-TRUTH rows and uploads them, so the
 * record has to live in synced data so one device runs and the rest see it
 * taken. WORKSPACE-scoped, not per-user — a shared workspace's other users'
 * devices must see the claim too, or they run the same upload-carrying pass
 * again. Being a real block is the point rather than an accident: a device
 * that dies mid-pass leaves a claim nobody will release, and the recovery is to
 * look at it and clear it — through {@link releaseStrandedGraphBackfillClaim},
 * which refuses the two rows a hand-delete cannot tell apart.
 *
 * This RECORDS a run; it does not arbitrate one. Exactly-once comes from the
 * pass being `trigger: 'operator'` — a human runs it, on one device,
 * deliberately.
 *
 * Do not add arbitration back. Exactly-once across N devices over a
 * last-write-wins layer with no server arbitration is not reachable: every
 * layer of the pipeline is another place a local read is stale (upload queue,
 * download checkpoint, the throttled `blocks_synced` drain, the rejection
 * quarantine), and each wait added to cover one needs a timeout, which
 * strands a claim, which needs reclaim, which needs arbitration.
 */

import { ChangeScope, type BlockData, type Tx } from '@/data/api'
import type { BackfillCompletionClaim, ClaimAttempt } from '@/data/facets'
import { keyAtStart } from '@/data/orderKey'
import { MIGRATION_CLAIM_TYPE } from '@/data/blockTypes'
import { classifyOccupant, stateChildBlockId } from '@/data/derivedIds'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
import { MIGRATIONS_PAGE_ALIAS, migrationsPageBlockId } from '@/data/migrationsPage'
import {
  addBlockTypeToProperties,
  migrationClaimantProp,
  migrationClaimedAtProp,
  migrationCompletedAtProp,
} from '@/data/properties'

/** What a claim block carries. Absent `completedAt` means "in flight". */
export interface GraphBackfillClaim {
  readonly claimantId: string
  readonly claimedAt: number
  readonly completedAt?: number
}

export type ClaimDecision =
  /** No claim exists — write one, settle, then re-read before running. */
  | 'claim'
  /** The settled claim names us. Run the pass. */
  | 'proceed'
  /** The settled claim names someone else, still in flight. Do nothing. */
  | 'back-off'
  /** Someone finished it. Never run again. */
  | 'already-complete'

/**
 * Decide what this device should do, given the claim it can currently see.
 *
 * Split out from the IO so the rule is testable on its own: the interesting
 * failures here are all "which branch, given what the row says", and the
 * surrounding settle-then-re-read dance is environmental.
 *
 * `completedAt` is checked BEFORE ownership on purpose. A device that ran the
 * pass, finished, and later re-opens the workspace still sees its own id in
 * `claimantId` — reading ownership first would have it run the whole pass
 * again on every open, which is the exact failure `per-graph` exists to stop.
 */
export const decideClaim = (
  claim: GraphBackfillClaim | null,
  claimantId: string,
): ClaimDecision => {
  if (claim === null) return 'claim'
  if (claim.completedAt !== undefined) return 'already-complete'
  return claim.claimantId === claimantId ? 'proceed' : 'back-off'
}

// ---------------------------------------------------------------------------
// IO
// ---------------------------------------------------------------------------

/** Deterministic id of the claim block for one backfill in one workspace.
 *  A state child of the workspace's Migrations page, so every device in the
 *  graph derives the same id and their writes converge on one row. */
export const graphBackfillClaimBlockId = (
  workspaceId: string,
  backfillId: string,
): string => stateChildBlockId(migrationsPageBlockId(workspaceId), backfillId)

/** Decode a claim from a property bag. `null` when the bag is not a claim —
 *  which the callers treat as UNCLAIMED, so a hand-edited or half-written row
 *  can never wedge every future run of every backfill. Kept separate from the
 *  DB read so the writing transaction decides against its OWN row with the
 *  same rule, rather than a second hand-rolled copy of it. */
export const claimFromProperties = (
  props: Record<string, unknown>,
): GraphBackfillClaim | null => {
  const claimantId = props[migrationClaimantProp.name]
  const claimedAt = props[migrationClaimedAtProp.name]
  if (typeof claimantId !== 'string' || typeof claimedAt !== 'number') return null
  const completedAt = props[migrationCompletedAtProp.name]
  return typeof completedAt === 'number'
    ? {claimantId, claimedAt, completedAt}
    : {claimantId, claimedAt}
}

/** Read the claim as the local DB currently has it. `null` when no row
 *  exists, and also when the row is a tombstone — releasing a claim deletes the
 *  block, so a tombstone must read as "unclaimed", not as "claimed by a
 *  ghost". */
export const readGraphBackfillClaim = async (
  db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>},
  claimId: string,
  workspaceId: string,
): Promise<GraphBackfillClaim | null> => {
  // Workspace-SCOPED, though the id is derived from the workspace. A row can
  // still arrive at this id owned by another workspace — an import that keeps
  // its ids is the realistic route — and reading it unscoped would let a
  // foreign block suppress this workspace's migration, or send the write
  // branches below at someone else's data. `classifyOccupant` exists because
  // this exact omission was found three times in three copies of the same
  // predicate.
  const row = await db.getOptional<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ? AND workspace_id = ? AND deleted = 0',
    [claimId, workspaceId],
  )
  if (!row) return null
  try {
    return claimFromProperties(JSON.parse(row.properties_json || '{}') as Record<string, unknown>)
  } catch {
    return null
  }
}

/** Does this claim, as decoded, hold the graph?
 *
 *  A COMPLETED claim deliberately does not: it records a finished run and is
 *  never released, so reading it as holding would refuse this graph's writes for
 *  the rest of its life. `null` does not either — absent, tombstoned and
 *  undecodable all land there, which is the same permissive direction
 *  {@link readGraphBackfillClaim} takes and for the same reason: a half-written
 *  bag must never wedge a workspace shut for good.
 *
 *  One predicate because three callers ask it — the dialog that blocks the
 *  workspace, the release it offers, and the gesture's own report — and a copy
 *  that drifts means one of them saying "nothing is held" while the others
 *  hold a modal over the app. */
export const claimHoldsGraph = (
  claim: GraphBackfillClaim | null,
): claim is GraphBackfillClaim => claim !== null && claim.completedAt === undefined

/** The claim a BLOCK ROW carries, when that row is this workspace's live claim.
 *
 *  For the reader that holds the row rather than a db handle: the migration
 *  dialog subscribes to the claim block, so the claim reaches every device —
 *  and clears again — through the same invalidation any other block read uses,
 *  with no polling and nothing to arm at startup.
 *
 *  Workspace-SCOPED for the reason {@link readGraphBackfillClaim} spells out: a
 *  row owned by another workspace can arrive at this id, and holding a modal
 *  over this workspace because of it would be unrecoverable from inside the
 *  app. */
export const claimHoldingGraph = (
  row: Pick<BlockData, 'deleted' | 'workspaceId' | 'properties'> | null | undefined,
  workspaceId: string,
): GraphBackfillClaim | null => {
  // `row.deleted` is DEFENCE IN DEPTH through today's only caller — `Block.peek`
  // is tombstone-aware and hands back `null` — and is kept because the parameter
  // is a raw row type and a RELEASED claim is exactly a tombstone: a reader that
  // skipped it would hold a modal over a workspace nobody is migrating, forever.
  if (!row || row.deleted || row.workspaceId !== workspaceId) return null
  const claim = claimFromProperties(row.properties)
  return claimHoldsGraph(claim) ? claim : null
}

/** The claim this row carries when the run it records has FINISHED.
 *
 *  The complement of {@link claimHoldingGraph}, and needed because that one
 *  filters a completed claim out by design: liveness alone cannot tell a pass
 *  that ran to the end from a claim that was handed back, and those two endings
 *  owe the user different things. A completion is the only durable record that
 *  rows were rewritten. */
export const completedClaimFor = (
  row: Pick<BlockData, 'deleted' | 'workspaceId' | 'properties'> | null | undefined,
  workspaceId: string,
): GraphBackfillClaim | null => {
  if (!row || row.deleted || row.workspaceId !== workspaceId) return null
  const claim = claimFromProperties(row.properties)
  return claim !== null && claim.completedAt !== undefined ? claim : null
}

/** Is a run of `backfillId` in flight for this workspace, as the caller's own
 *  view of `blocks` has it?
 *
 *  Asked by anything that must not write while a once-per-graph pass is midway
 *  through the same data — today the definition-change refusal
 *  (`propertyDefinitionChangeProcessor`), which asks it INSIDE the user's
 *  transaction so the answer is that transaction's own. The claim lives in
 *  SYNCED data, so a peer device that has received the claim row refuses too;
 *  one that has not yet is the same staleness every other reader of this row
 *  has. */
export const isGraphBackfillClaimActive = async (
  db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>},
  workspaceId: string,
  backfillId: string,
): Promise<boolean> =>
  claimHoldsGraph(await readGraphBackfillClaim(
    db, graphBackfillClaimBlockId(workspaceId, backfillId), workspaceId,
  ))

/** Where a claim nobody will release is found and cleared, in the one wording
 *  every message that needs it uses.
 *
 *  Every message that mentions a held claim — the pass reporting one held by
 *  another client, the definition-change refusal, the gesture reporting that it
 *  did not hand the workspace back — describes the SAME recovery, and an
 *  operator who reads them as different situations goes looking for a second
 *  thing to do. */
export const STRANDED_CLAIM_RECOVERY =
  'the dialog this workspace is blocked behind offers to release it — and where '
  + `that dialog is turned off, the claim block is on the "${MIGRATIONS_PAGE_ALIAS}" page`

// ---------------------------------------------------------------------------
// The seam implementation
// ---------------------------------------------------------------------------

/** Minimal surface the claim needs, so it can be built at the composition
 *  root without dragging the whole Repo type into its tests. */
export interface GraphBackfillClaimDeps {
  readonly db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>}
  tx<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: {
      scope: ChangeScope
      skipUndo?: boolean
      description?: string
    },
  ): Promise<R>
  /** Who holds the claim. LOAD-BEARING: `decideClaim` returns `proceed` only
   *  when a live claim names this id, and `releaseClaim` refuses unless it
   *  does — so a value that does not survive a reload leaves a claim nobody
   *  can ever match and wedges the pass for the whole graph. Per browser
   *  PROFILE, not per tab: two tabs of one browser share it. */
  readonly claimantId: string
  ensureHome(workspaceId: string): Promise<unknown>
}

/** Every write this module makes, under the one set of options they all need.
 *
 *  `skipUndo` because none of this is a document edit the user could mean to
 *  undo, and `BlockDefault` because the row is an ordinary block that must stay
 *  read-only-gated and seed-guarded. */
const claimTx = <R>(
  deps: Pick<GraphBackfillClaimDeps, 'tx'>,
  description: string,
  fn: (tx: Tx) => Promise<R>,
): Promise<R> => deps.tx(fn, {
  scope: ChangeScope.BlockDefault,
  skipUndo: true,
  description,
})

/** Refuse a row at the claim id that belongs to ANOTHER workspace.
 *
 *  Every write path here reaches its row through `tx.get`, which selects on
 *  id alone, and then rewrites properties or restores a tombstone. On a
 *  foreign block that is a cross-workspace write — the one thing a
 *  deterministic-id caller must never do. Extracted rather than repeated
 *  because it was written in `tryClaim` and forgotten in `markComplete`,
 *  which is how the three earlier copies of this predicate diverged. */
const refuseForeignOccupant = (
  row: {workspaceId: string; deleted: boolean} | null | undefined,
  workspaceId: string,
  claimId: string,
): void => {
  if (classifyOccupant((row ?? null) as never, {workspaceId}).verdict !== 'foreign') return
  throw new DeterministicIdCrossWorkspaceError(claimId, row!.workspaceId, workspaceId)
}

/**
 * Clear a claim nobody will release, from a device that does not hold it.
 *
 * The operator recovery for a claimant that died mid-pass. `releaseClaim`
 * cannot serve: it decides ownership by claimant id, which is per browser
 * PROFILE, so it does nothing for the case that actually strands a workspace —
 * the device that took the claim is gone. Deleting the block by hand can, and
 * that is the problem: it deletes whatever is at the id, and two of the rows
 * that can be there must survive.
 *
 * So this releases ONLY a claim that is actually holding the workspace: a
 * COMPLETED claim is the record that the migration ran and deleting it would
 * read as never-migrated, and a row that does not decode as a claim is holding
 * nothing and belongs to something else.
 *
 * It cannot tell a dead claimant from a live one — nothing can, over a
 * last-write-wins layer with no arbitration. The caller confirms, and passes
 * back the claim they confirmed AGAINST, so consent cannot be spent on a
 * different one.
 */
export const releaseStrandedGraphBackfillClaim = async (
  deps: Pick<GraphBackfillClaimDeps, 'tx'>,
  workspaceId: string,
  backfillId: string,
  /** The claim the caller showed the user and got consent for. A different one
   *  in the row means the situation they agreed to is gone — the original
   *  finished, or someone released it and a fresh run took the graph — so this
   *  refuses rather than deleting a claim nobody consented to deleting. The
   *  gap is a human pause, which is as long as gaps get. */
  expected: Pick<GraphBackfillClaim, 'claimantId' | 'claimedAt'>,
): Promise<'released' | 'not-held' | 'changed'> => {
  const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
  return claimTx(deps, `release stranded backfill claim ${backfillId}`, async tx => {
    const row = await tx.get(claimId)
    refuseForeignOccupant(row, workspaceId, claimId)
    if (!row || row.deleted) return 'not-held'
    const live = claimFromProperties(row.properties)
    if (!claimHoldsGraph(live)) return 'not-held'
    if (live.claimantId !== expected.claimantId || live.claimedAt !== expected.claimedAt) {
      return 'changed'
    }
    await tx.delete(claimId)
    return 'released'
  })
}

export const createGraphBackfillClaim = (
  deps: GraphBackfillClaimDeps,
): BackfillCompletionClaim => ({
  async tryClaim(workspaceId, backfillId, opts) {
    const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
    // Ensure our own parent rather than trusting bootstrap ordering: a claim
    // that silently fails to write reads as "unclaimed" on every device,
    // which is the one outcome that turns this into a duplicated pass.
    await deps.ensureHome(workspaceId)

    const first = decideClaim(await readGraphBackfillClaim(deps.db, claimId, workspaceId), deps.claimantId)
    if (first === 'back-off') return 'declined'
    // A recorded completion stops an UNATTENDED pass, which is its job. It
    // must not stop a human who deliberately asked for one: this seam's passes
    // are idempotent per row, so a redundant run is a scan and no writes, while
    // refusing means anything the previous run missed — a block edited behind
    // its cursor, a legacy value repaired since — is unmigrated forever. The
    // claim's safety property is mutual exclusion (`back-off`, above), and
    // that still holds.
    if (first === 'already-complete' && !opts?.reclaimCompleted) return 'declined'
    // `proceed` means a claim here already names us — normally our own from a
    // previous operator run of the same pass. Taken at face value: there is
    // nothing to wait for, because nothing arbitrates (see the module header).
    // Two invocations in ONE Repo also land here, since they share a
    // claimant; `Repo.runWorkspaceBackfillNow` single-flights that, because
    // no claim can tell those two apart.

    // Typed so the Recents exclusion skips it: that filter tests system types
    // on each RESULT ROW, so the parent page's own marker does not cover the
    // rows beneath it. Via `addBlockTypeToProperties` because this is raw
    // BlockData being planned, which is the one sanctioned direct-write path.
    //
    // KNOWN GAP: post-flip the value CHILDREN carry no system type and still
    // read as user activity — not claim-specific, tracked in #389.
    const claimProperties = addBlockTypeToProperties({
      [migrationClaimantProp.name]: deps.claimantId,
      [migrationClaimedAtProp.name]: Date.now(),
    }, MIGRATION_CLAIM_TYPE)
    // `already-complete` under `reclaimCompleted` takes the writing path too:
    // the row exists and carries a completion stamp, which has to be replaced
    // by a fresh claim or `markComplete` would be re-stamping someone else's
    // record of a run that is not this one.
    // `proceed` writes NOTHING — a live claim already names us. Reported as
    // `inherited` rather than as a win: this claimant is a browser profile, so
    // the row may be a sibling TAB's live claim, and a caller that released it
    // would delete a claim somebody is still writing under.
    const won: ClaimAttempt = first === 'proceed'
      ? 'inherited'
      : await claimTx(deps, `claim backfill ${backfillId}`, async tx => {
        // Re-checked inside the WRITING tx against this row: the read above
        // happened outside it, and a peer's claim can arrive in between.
        const existing = await tx.get(claimId)
        refuseForeignOccupant(existing, workspaceId, claimId)
        if (existing && !existing.deleted) {
          // Yield only to a row that DECODES as a claim, and tell the caller —
          // a claim that arrived since the read above is authoritative, and a
          // caller not told runs a migration it just watched someone else take.
          // A live row whose bookkeeping is malformed reads as unclaimed to
          // every reader, so yielding on mere existence wedged the migration
          // shut for good; the id is machinery-owned, so overwriting a non-claim
          // there is repair.
          //
          // Except a COMPLETED claim under `reclaimCompleted`: it names a
          // finished pass, and an operator asking again is asking on purpose.
          // The overwrite is the point — leaving the completion stamp would make
          // `markComplete` re-stamp a record of someone else's run. An in-flight
          // claim still refuses, which is the mutual exclusion this seam
          // actually provides.
          const live = claimFromProperties(existing.properties)
          if (live !== null
              && !(opts?.reclaimCompleted === true && live.completedAt !== undefined)) {
            return 'declined'
          }
          await tx.update(claimId, {properties: claimProperties})
          return 'minted'
        }
        if (existing?.deleted) {
          // Restore, don't create: deleting the claim is the documented
          // recovery for a dead claimant and leaves a TOMBSTONE here, on which
          // `tx.create` throws DuplicateIdError — the caller swallows that as
          // "skip", so the gesture meant to REOPEN the migration would wedge
          // it shut.
          //
          // ACCEPTED: unlike the create below, this reclaim is not
          // single-winner — `systemMint` is insert-only, so restore+update
          // emits nonzero-stamped patches and two clients reopening
          // concurrently can both believe they hold it. The residual is a
          // duplicate run of a per-row-idempotent pass, after a human
          // deliberately deleted a claim.
          await tx.restore(claimId, {content: backfillId})
          await tx.update(claimId, {properties: claimProperties})
          return 'minted'
        }
        // `systemMint` (stamp 0) like every other deterministic-id creator.
        // Without it this is a nonzero-stamp mint of a shared id, which
        // `syncObserver/reconcile.ts` names as its known blind spot: two devices
        // minting the same id produce equal nonzero stamps from different
        // writes, invariant I1 reads them as identical, the incoming row is
        // skip-stale'd, and the loser strands believing it won. Stamp 0 yields
        // via I2 instead, so both devices adopt the server's answer.
        await tx.create({
          id: claimId,
          workspaceId,
          parentId: migrationsPageBlockId(workspaceId),
          orderKey: keyAtStart(),
          content: backfillId,
          properties: claimProperties,
        }, {systemMint: true})
        return 'minted'
      })

    // No convergence wait. Under an operator trigger there is nothing to
    // arbitrate, and the wait was unwinnable anyway — see the module header.
    return won
  },

  async markComplete(workspaceId, backfillId) {
    const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
    await claimTx(deps, `complete backfill ${backfillId}`, async tx => {
      const row = await tx.get(claimId)
      refuseForeignOccupant(row, workspaceId, claimId)
      if (!row) {
        throw new Error(
          `[graphBackfillClaim] cannot record completion of "${backfillId}": its claim ` +
          `block is gone. The pass ran but nothing records it, so the next operator ` +
          `would repeat it.`,
        )
      }
      // A TOMBSTONE has to be restored, not stamped. Two operators can run
      // concurrently on different devices (accepted — see the module header),
      // and the one that aborts releases the claim they share; its delete can
      // sync in before the survivor completes. Stamping `completedAt` onto a
      // deleted row records nothing: `readGraphBackfillClaim` filters
      // `deleted = 0`, so every device still reads "unclaimed" and the next
      // operator repeats the whole migration — while this one was told "ran".
      if (row.deleted) await tx.restore(claimId, {content: backfillId})
      await tx.update(claimId, {
        properties: {...row.properties, [migrationCompletedAtProp.name]: Date.now()},
      })
    })
  },

  async releaseClaim(workspaceId, backfillId) {
    const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
    await claimTx(deps, `release backfill claim ${backfillId}`, async tx => {
      // Ownership is decided from the TRANSACTION's own row, not from a read
      // taken before it. Sync can replace this device's claim with the
      // winner's in that gap, and deleting on the strength of the stale read
      // would remove a PEER's live claim — freeing a second device to start
      // the same source-of-truth pass while the winner is still running.
      const row = await tx.get(claimId)
      refuseForeignOccupant(row, workspaceId, claimId)
      if (!row || row.deleted) return
      if (decideClaim(claimFromProperties(row.properties), deps.claimantId) !== 'proceed') return
      // ACCEPTED: when this claim came from an operator RECLAIM, deleting it
      // also drops the graph's record that the pass ever completed, so the
      // graph reads as never-migrated. Nothing consumes that record except
      // `tryClaim`, and an operator run reclaims a completed claim anyway, so
      // today the difference is unobservable. Preserving it needs a second
      // key carried through the reclaim — worth it only once something reads
      // "was this graph migrated" as durable state (km-bmka).
      //
      // `Repo.withOperatorBackfillClaim` WIDENED this: it reclaims before its
      // body writes, so any pre-pass abort — a synthesis that threw, a flip
      // that was refused — now reaches this delete with the prior completion
      // stamp already overwritten. Same residual, more ways in.
      await tx.delete(claimId)
    })
  },
})
