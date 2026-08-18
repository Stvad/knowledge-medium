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
 * ## Why last-write-wins is enough
 *
 * Two devices opening a freshly flipped workspace both see no claim and both
 * write one. They write the SAME block id, so sync converges on one winner,
 * and once it has, both devices read the same value — whoever is named
 * proceeds and the other backs off. That is real mutual exclusion, but ONLY
 * on the far side of convergence: a read taken before the write has settled
 * says "mine" on both devices. The caller therefore claims, waits for sync to
 * settle, and re-reads before doing any bulk work.
 *
 * The residual window degrades to wasted work, never to wrong data: the pass
 * is idempotent per row, and `assertBackfillMayWrite` aborts a losing device
 * cleanly mid-pass.
 *
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
  /** Runs `cb` once this device is connected and not downloading. */
  syncSettled(cb: () => void): () => void
  /** Identifies this claimant. Must be at least as fine-grained as a device:
   *  finer is harmless (two windows share a local DB, so the loser sees the
   *  winner on its first read), coarser is the dangerous direction, because
   *  two devices would then read each other's claim as their own. */
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
        await tx.restore(claimId, {content: backfillId})
        await tx.update(claimId, {properties: claimProperties})
        return
      }
      await tx.create({
        id: claimId,
        workspaceId,
        parentId: migrationsPageBlockId(workspaceId),
        orderKey: keyAtStart(null),
        content: backfillId,
        properties: claimProperties,
      })
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `claim backfill ${backfillId}`})

    // Settle, THEN re-read. The write above is not a decision: before
    // convergence every racing device reads its own claim back and believes
    // it won. Only the post-settle read is authoritative.
    //
    // Do NOT invoke the returned disposer here. It unregisters the listener,
    // and an earlier version called it eagerly — so whenever the gate was not
    // ALREADY settled the callback could never fire, this promise never
    // resolved, and `tryClaim` hung for the session while the claim it had
    // just written made every other device back off. `onSyncSettled` disposes
    // its own listener before invoking the callback, so there is nothing to
    // clean up on the resolving path.
    await new Promise<void>(resolve => { deps.syncSettled(resolve) })
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
