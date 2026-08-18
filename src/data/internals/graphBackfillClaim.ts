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
import { stateChildBlockId } from '@/data/derivedIds'
import { migrationsPageBlockId } from '@/data/migrationsPage'
import {
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
export const readGraphBackfillClaim = async (
  db: {getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>},
  claimId: string,
): Promise<GraphBackfillClaim | null> => {
  const row = await db.getOptional<{properties_json: string}>(
    'SELECT properties_json FROM blocks WHERE id = ? AND deleted = 0', [claimId],
  )
  if (row === null || row === undefined) return null
  let props: Record<string, unknown>
  try {
    props = JSON.parse(row.properties_json || '{}') as Record<string, unknown>
  } catch {
    return null
  }
  const claimantId = props[migrationClaimantProp.name]
  const claimedAt = props[migrationClaimedAtProp.name]
  // A row that does not parse as a claim reads as unclaimed rather than
  // throwing: this runs on the workspace-open path, and a malformed claim
  // must not be able to wedge every future run of every backfill.
  if (typeof claimantId !== 'string' || typeof claimedAt !== 'number') return null
  const completedAt = props[migrationCompletedAtProp.name]
  return typeof completedAt === 'number'
    ? {claimantId, claimedAt, completedAt}
    : {claimantId, claimedAt}
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

    await deps.tx(async tx => {
      await tx.create({
        id: claimId,
        workspaceId,
        parentId: migrationsPageBlockId(workspaceId),
        orderKey: keyAtStart(null),
        content: backfillId,
        properties: {
          [migrationClaimantProp.name]: deps.claimantId,
          [migrationClaimedAtProp.name]: Date.now(),
        },
      })
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `claim backfill ${backfillId}`})

    // Settle, THEN re-read. The write above is not a decision: before
    // convergence every racing device reads its own claim back and believes
    // it won. Only the post-settle read is authoritative.
    await new Promise<void>(resolve => { deps.syncSettled(resolve)() })
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
    const claim = await readGraphBackfillClaim(deps.db, claimId)
    // Release only what is still OURS and still in flight. A claim that
    // converged to another device belongs to that run, and deleting it here
    // would hand a second device the right to run concurrently — turning an
    // abort on this device into the duplicate uploading pass the seam exists
    // to prevent.
    if (claim === null || claim.claimantId !== deps.claimantId) return
    if (claim.completedAt !== undefined) return
    await deps.tx(async tx => {
      const row = await tx.get(claimId)
      if (!row) return
      await tx.delete(claimId)
    }, {scope: ChangeScope.BlockDefault, skipUndo: true,
        description: `release backfill claim ${backfillId}`})
  },
})
