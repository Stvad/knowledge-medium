/**
 * The synced completion claim a `per-graph` workspace backfill needs.
 *
 * A `per-device` backfill records a local marker, so every device runs it
 * once. A `per-graph` pass repairs SOURCE-OF-TRUTH rows and uploads them, so
 * running it everywhere is the hazard rather than a side effect — the claim
 * has to live in synced data so one device runs and the rest see it taken.
 *
 * `blocks` is the only synced table a client writes, so the claim is a block:
 * a state child under the workspace's Migrations page, at a deterministic id,
 * one per backfill. Being a real block is the point rather than an accident —
 * a device that dies mid-pass leaves a claim nobody will release, and the
 * recovery for that is "look at it, delete it".
 *
 * WORKSPACE-scoped, not per-user. A workspace can be shared, and a claim
 * hanging off one user's page would be invisible to another user's devices —
 * which would run the same upload-carrying pass again, the exact hazard
 * `per-graph` exists to prevent.
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
