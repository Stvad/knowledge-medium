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
 * ## This RECORDS a run; it does not arbitrate one
 *
 * Exactly-once comes from the pass being `trigger: 'operator'` — a human runs
 * it, on one device, deliberately (§11, "operator-run-once per workspace").
 * Nothing here decides who may run; there is no race to decide.
 *
 * Do not add arbitration back. Exactly-once across N devices over a
 * last-write-wins layer with no server arbitration is not reachable: every
 * layer of the pipeline is another place a local read is stale (upload queue,
 * download checkpoint, the throttled `blocks_synced` drain, the rejection
 * quarantine), and each wait added to cover one needs a timeout, which
 * strands a claim, which needs reclaim, which needs arbitration. An earlier
 * revision tried and the regress had no fixed point.
 *
 * What the record buys:
 *  - a completed pass is visible to every device, so a second operator is
 *    told it is done. Duplicate "done" is harmless under LWW, which is why
 *    recording needs no arbitration.
 *  - an in-flight claim is a readable, deletable block, so an interrupted run
 *    is diagnosable rather than invisible.
 *
 * What it does not: two operators triggering simultaneously on two devices
 * both run. Accepted — it takes deliberate human action on two machines at
 * once, and these passes are idempotent per row.
 */

import { ChangeScope, type Tx } from '@/data/api'
import type { BackfillCompletionClaim } from '@/data/facets'
import { keyAtStart } from '@/data/orderKey'
import { MIGRATION_CLAIM_TYPE } from '@/data/blockTypes'
import { classifyOccupant, stateChildBlockId } from '@/data/derivedIds'
import { DeterministicIdCrossWorkspaceError } from '@/data/api/errors'
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
  /** Who holds the claim. Diagnostic rather than load-bearing now: nothing
   *  branches on exclusivity, so this only has to be specific enough to tell
   *  an operator WHICH client left an in-flight claim behind. */
  readonly claimantId: string
  ensureHome(workspaceId: string): Promise<unknown>
}

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

/** localStorage key for this browser profile's claimant identity. */
const CLAIMANT_STORAGE_KEY = 'km:migration-claimant'

/**
 * A claimant id that survives a reload.
 *
 * It is not diagnostic: `decideClaim` returns `proceed` only when a live claim
 * names US. With a fresh id per session, a tab that closed or crashed mid-pass
 * left a claim nobody could ever match again — the migration was wedged for
 * the whole graph until someone deleted the claim block by hand, which is not
 * an instruction a user can follow. Persisted per browser profile, the same
 * device just picks its own claim back up and carries on.
 *
 * Falls back to a per-session id when storage is unavailable (private mode, a
 * blocked origin). That is the old behaviour and it degrades the same way:
 * recovery needs the claim deleted. It does not degrade CORRECTNESS — two
 * devices still cannot both hold a claim.
 */
export const resolveClaimantId = (
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined,
  newId: () => string,
): string => {
  try {
    const stored = storage?.getItem(CLAIMANT_STORAGE_KEY)
    if (stored) return stored
    const minted = newId()
    storage?.setItem(CLAIMANT_STORAGE_KEY, minted)
    return minted
  } catch {
    return newId()
  }
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
    if (first === 'back-off') return false
    // A recorded completion stops an UNATTENDED pass, which is its job. It
    // must not stop a human who deliberately asked for one: this seam's passes
    // are idempotent per row, so a redundant run is a scan and no writes, while
    // refusing means anything the previous run missed — a block edited behind
    // its cursor, a legacy value repaired since — is unmigrated forever. The
    // claim's safety property is mutual exclusion (`back-off`, above), and
    // that still holds.
    if (first === 'already-complete' && !opts?.reclaimCompleted) return false
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
    // KNOWN GAP, deliberately not fixed here: post-flip these properties
    // materialize into field/value CHILDREN, which carry no system type, so
    // they still read as user activity. The honest fix is not claim-specific
    // — "property machinery must not look like an edit" is the invisibility
    // half of slice C (#389), and it needs a decision about whether Recents
    // excludes descendants of system-typed rows or maps machinery to its
    // owner. Tagging one block's descendants would leave the class untouched.
    const claimProperties = addBlockTypeToProperties({
      [migrationClaimantProp.name]: deps.claimantId,
      [migrationClaimedAtProp.name]: Date.now(),
    }, MIGRATION_CLAIM_TYPE)
    // `already-complete` under `reclaimCompleted` takes the writing path too:
    // the row exists and carries a completion stamp, which has to be replaced
    // by a fresh claim or `markComplete` would be re-stamping someone else's
    // record of a run that is not this one.
    const won = first === 'proceed' ? true : await deps.tx(async tx => {
      // Re-checked inside the WRITING tx against this row: the read above
      // happened outside it, and a peer's claim can arrive in between.
      const existing = await tx.get(claimId)
      refuseForeignOccupant(existing, workspaceId, claimId)
      if (existing && !existing.deleted) {
        // Yield only to a row that actually decodes AS a claim. A live row
        // whose bookkeeping is missing or malformed reads as UNCLAIMED to
        // every reader, so returning on mere existence left the post-settle
        // read unclaimed too — `tryClaim` returned false, and every later
        // open took the identical path. The migration could never run again.
        // The id is machinery-owned, so overwriting a non-claim there is
        // repair, not data loss.
        // A valid claim arrived between the read above and this transaction.
        // It is authoritative — and the caller must be TOLD, or it runs a
        // migration it just watched someone else take.
        //
        // Except a COMPLETED one under `reclaimCompleted`: that names no
        // running pass, only a finished one, and an operator asking again is
        // asking on purpose. Overwriting it with a fresh claim is the point —
        // leaving the completion stamp in place would make `markComplete`
        // re-stamp a record of a run that is not this one. An in-flight claim
        // still refuses here, which is the mutual exclusion this seam
        // actually provides.
        const live = claimFromProperties(existing.properties)
        if (live !== null
            && !(opts?.reclaimCompleted === true && live.completedAt !== undefined)) {
          return false
        }
        await tx.update(claimId, {properties: claimProperties})
        return true
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
        return true
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
      return true
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `claim backfill ${backfillId}`})

    // No convergence wait. Under an operator trigger there is nothing to
    // arbitrate, and the wait was unwinnable anyway — see the module header.
    return won
  },

  async markComplete(workspaceId, backfillId) {
    const claimId = graphBackfillClaimBlockId(workspaceId, backfillId)
    await deps.tx(async tx => {
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
      refuseForeignOccupant(row, workspaceId, claimId)
      if (!row || row.deleted) return
      if (decideClaim(claimFromProperties(row.properties), deps.claimantId) !== 'proceed') return
      await tx.delete(claimId)
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `release backfill claim ${backfillId}`})
  },
})
