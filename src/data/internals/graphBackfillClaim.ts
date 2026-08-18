/**
 * The production `BackfillCompletionClaim`: block-backed, synced, one claim
 * per (workspace, backfill).
 *
 * A workspace backfill repairs SOURCE-OF-TRUTH rows and uploads them, so
 * running it on every device is the hazard rather than a side effect — the
 * record has to live in synced data so one device runs and the rest see it
 * taken.
 *
 * `blocks` is the only synced table a client writes, so the claim is a block:
 * a state child under the workspace's Migrations page, at a deterministic id,
 * one per backfill. Being a real block is the point rather than an accident —
 * a device that dies mid-pass leaves a claim nobody will release, and the
 * recovery for that is "look at it, delete it".
 *
 * WORKSPACE-scoped, not per-user. A workspace can be shared, and a claim
 * hanging off one user's page would be invisible to another user's devices —
 * which would run the same upload-carrying pass again, the exact hazard this
 * seam exists to prevent.
 *
 * ## What makes the re-read a decision
 *
 * Two devices opening a freshly flipped workspace both see no claim and both
 * write one, to the SAME block id. Reading straight back proves nothing —
 * each sees its own row. Two things make the second read authoritative:
 *
 *  - `awaitConverged` (`claimConvergence.ts`) blocks until our write has
 *    reached the server AND a checkpoint has come back, so what we then read
 *    is the server's resolution rather than our own echo. A timeout backs
 *    OFF; proceeding unconverged is the failure this exists to prevent.
 *  - the create is a `systemMint` (stamp 0). Two nonzero-stamp mints of one
 *    deterministic id are misread as identical by the reconcile gate, and the
 *    loser strands believing it won — the shape `syncObserver/reconcile.ts`
 *    documents. Stamp 0 makes both yield to the server instead.
 *
 * Both are pinned over two real databases in `graphBackfillClaimRace.test.ts`;
 * removing either lets both devices proceed.
 *
 * A device that loses AFTER starting is caught by nothing here — the runner's
 * per-transaction preconditions check generation, workspace and sync state,
 * not the claim — so it writes until its pass ends. Tolerable only because
 * these passes are idempotent per row.
 */

import { ChangeScope, type Tx } from '@/data/api'
import type { BackfillCompletionClaim } from '@/data/facets'
import { keyAtStart } from '@/data/orderKey'
import { MIGRATION_CLAIM_TYPE } from '@/data/blockTypes'
import { stateChildBlockId } from '@/data/derivedIds'
import { migrationsPageBlockId } from '@/data/migrationsPage'
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

/** Read the claim as the local DB currently has it. `null` when no row
 *  exists, and also when the row is a tombstone — deleting the claim block
 *  IS the documented recovery for a device that died mid-pass, so a
 *  tombstone must read as "unclaimed", not as "claimed by a ghost". */
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

export const readGraphBackfillClaim = async (
  db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>},
  claimId: string,
): Promise<GraphBackfillClaim | null> => {
  const row = await db.getOptional<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ? AND deleted = 0', [claimId],
  )
  if (!row) return null
  try {
    return claimFromProperties(JSON.parse(row.properties_json || '{}') as Record<string, unknown>)
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// The seam implementation
// ---------------------------------------------------------------------------

/** Minimal surface the claim needs, so it can be built at the composition
 *  root without dragging the whole Repo type into its tests. */
export interface GraphBackfillClaimDeps {
  readonly db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>}
  tx<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: {scope: ChangeScope; skipUndo?: boolean; description?: string},
  ): Promise<R>
  /** Resolves true once this device's claim write has reached the server AND
   *  a checkpoint has since come back — i.e. the local row is now the
   *  server's answer rather than our own echo. False means back off.
   *  See `claimConvergence.ts`; `connected && !downloading` is NOT this. */
  awaitConverged(claimId: string): Promise<boolean>
  /** Identifies this claimant, and must be UNIQUE per client instance.
   *
   *  Shared is the failure that matters: two clients carrying one token both
   *  read the converged claim as their own and both run the pass, which no
   *  amount of convergence can fix. That ruled out the layout-session id — an
   *  installed-app window and a duplicated tab can carry the same value.
   *
   *  The cost of uniqueness is that a restarted client cannot recognise its
   *  own stranded claim, so a client that dies mid-pass leaves one for a human
   *  to delete. That is the documented recovery either way, and it fails safe;
   *  a shared token fails toward the duplicate uploading pass. */
  readonly claimantId: string
  ensureHome(workspaceId: string): Promise<unknown>
}

export const createGraphBackfillClaim = (
  deps: GraphBackfillClaimDeps,
): BackfillCompletionClaim => ({
  async tryClaim(workspaceId, backfillId) {
    const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
    // Ensure our own parent rather than trusting bootstrap ordering: a claim
    // that silently fails to write reads as "unclaimed" on every device,
    // which is the one outcome that turns this into a duplicated pass.
    await deps.ensureHome(workspaceId)

    const first = decideClaim(await readGraphBackfillClaim(deps.db, claimId), deps.claimantId)
    if (first === 'already-complete' || first === 'back-off') return false
    if (first === 'proceed') return true

    // Typed so the Recents exclusion skips it: that filter tests system types
    // on each RESULT ROW, so the parent page's own marker does not cover the
    // rows beneath it. Via `addBlockTypeToProperties` because this is raw
    // BlockData being planned, which is the one sanctioned direct-write path.
    const claimProperties = addBlockTypeToProperties({
      [migrationClaimantProp.name]: deps.claimantId,
      [migrationClaimedAtProp.name]: Date.now(),
    }, MIGRATION_CLAIM_TYPE)
    await deps.tx(async tx => {
      // Re-checked inside the WRITING tx against this row: the read above
      // happened outside it, and a peer's claim can arrive in between.
      const existing = await tx.get(claimId)
      if (existing && !existing.deleted) {
        // Yield only to a row that actually decodes AS a claim. A live row
        // whose bookkeeping is missing or malformed reads as UNCLAIMED to
        // every reader, so returning on mere existence left the post-settle
        // read unclaimed too — `tryClaim` returned false, and every later
        // open took the identical path. The migration could never run again.
        // The id is machinery-owned, so overwriting a non-claim there is
        // repair, not data loss.
        if (claimFromProperties(existing.properties) !== null) return
        await tx.update(claimId, {properties: claimProperties})
        return
      }
      if (existing?.deleted) {
        // Deleting the claim block IS the documented recovery for a claimant
        // that never came back, and it leaves a TOMBSTONE at this
        // deterministic id. `tx.create` is a plain INSERT that throws
        // DuplicateIdError on one, which the caller swallows as "skip" — so
        // the gesture meant to REOPEN the migration would instead wedge it
        // shut for good. Restore the row instead of inserting a new one.
        //
        // ACCEPTED, not overlooked: this reclaim is NOT single-winner the way
        // the create above is. `systemMint` is an insert-only option by
        // design — a row may be born a speculative default, never promoted
        // into one — so restore+update emits ordinary nonzero-stamped
        // patches, and two clients reopening after the same deletion can each
        // end up believing they hold it. Making it single-winner needs
        // server-side arbitration this stack does not have.
        //
        // Taken because the outcome sits in the residual we already accept:
        // a duplicate run of a per-row-idempotent pass, in a window that
        // opens only after a human has deliberately deleted a claim AND two
        // clients reopen concurrently. The alternative — generation-suffixed
        // ids so each reclaim is a fresh systemMint create — buys single-
        // winner recovery for a permanent complication of the id scheme.
        await tx.restore(claimId, {content: backfillId})
        await tx.update(claimId, {properties: claimProperties})
        return
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
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `claim backfill ${backfillId}`})

    // Converge, THEN re-read. The write above is not a decision: until the
    // server has resolved it against any peer's write to the same id, every
    // racing device reads its own row back and believes it won.
    //
    // A timeout backs off rather than proceeding. The two outcomes are not
    // symmetric: not running is a deferral the next open retries, running
    // unconverged is the duplicated upload-carrying pass this exists to stop.
    if (!await deps.awaitConverged(claimId)) return false
    return decideClaim(await readGraphBackfillClaim(deps.db, claimId), deps.claimantId) === 'proceed'
  },

  async markComplete(workspaceId, backfillId) {
    const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
    await deps.tx(async tx => {
      const row = await tx.get(claimId)
      if (!row) return
      await tx.update(claimId, {
        properties: {...row.properties, [migrationCompletedAtProp.name]: Date.now()},
      })
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `complete backfill ${backfillId}`})
  },

  async releaseClaim(workspaceId, backfillId) {
    const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
    await deps.tx(async tx => {
      // Ownership is decided from the TRANSACTION's own row, not from a read
      // taken before it. Sync can replace this device's claim with the
      // winner's in that gap, and deleting on the strength of the stale read
      // would remove a PEER's live claim — freeing a second device to start
      // the same source-of-truth pass while the winner is still running.
      const row = await tx.get(claimId)
      if (!row || row.deleted) return
      if (decideClaim(claimFromProperties(row.properties), deps.claimantId) !== 'proceed') return
      await tx.delete(claimId)
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `release backfill claim ${backfillId}`})
  },
})
