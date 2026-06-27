/**
 * The down-lane reconciler (design §8/§9) — the background half of the byte-
 * replication subsystem. Where the up-lane drains local bytes the server lacks,
 * the down-lane reconciles the mirror: for each `media` block in an active
 * workspace whose bytes are ABSENT locally, fetch → decrypt → hash-verify → store,
 * so the workspace's images are available offline (§8 "every asset on disk").
 *
 * This is the PURE core (mirrors {@link drainUploads}). The caller (assetDownLane)
 * walks the local DB to produce the work-list and runs this single-owner under a
 * Web Lock; here we just iterate, leaning on the resolver's `replicate` for the
 * actual per-asset work + the shared coalescing fetch primitive (§8).
 *
 * THREE politeness controls, all here:
 *   - SEQUENTIAL — the "drip". One asset at a time, deliberately slow enough never
 *     to saturate the link or starve a demand fetch (the user-is-looking-at-it lane,
 *     which is `resolve`, not throttled and coalesces with us). The lowest possible
 *     concurrency; matches the up-lane drain.
 *   - A FETCH-ATTEMPT BUDGET — at most `budget` network attempts per pass, beyond
 *     which the long tail stays lazy (re-fetched on demand or the next pass) rather
 *     than blowing the origin quota / egress in one sweep (§8 "budget-capped"). An
 *     already-present block is FREE (a cheap has() probe, no egress) so the steady
 *     state walks the whole workspace for zero budget; only genuine downloads —
 *     success OR failure — consume it, so an offline pass can't hammer every absent
 *     block either.
 *   - FORWARD PROGRESS — because present blocks don't consume budget and a
 *     replicated block is present on the next pass, successive passes chew through
 *     the absent tail `budget` at a time instead of re-downloading the same head.
 *
 * SCOPE is the caller's job: it walks ONLY active/opened workspaces (the "don't
 * touch unopened workspaces" sync-flood lesson — §8). Failures don't halt the walk:
 * one poisoned / offline block doesn't stop the rest from replicating. The down-lane
 * keeps NO persisted state — a miss simply reappears on the next pass (the §9
 * "synced block can outlive its bytes" backstop self-heals when the origin uploads).
 */

import { PRE_FETCH_FAIL_REASONS, type AssetReplicateResult, type AssetResolveRequest } from './resolver.js'

/** Default fetch-attempt budget per pass — bounds eager replication egress while
 *  staying large enough that a modest workspace fully replicates in a pass or two.
 *  The tail beyond it is lazy-re-fetchable, never lost. */
export const DEFAULT_DOWN_LANE_BUDGET = 32

export interface DownLaneDeps {
  /** The §8 backlog lane — see {@link AssetResolver.replicate}. Only `replicate` is
   *  used; typed as a slice so tests need not build a whole resolver. */
  readonly resolver: { replicate(request: AssetResolveRequest): Promise<AssetReplicateResult> }
  /** Max FETCH ATTEMPTS (downloads, success or failure) this pass; present probes are
   *  free. Defaults to {@link DEFAULT_DOWN_LANE_BUDGET}. */
  readonly budget?: number
}

export interface DownLaneSummary {
  /** Already replicated — a cheap has() probe, no egress. */
  readonly present: number
  /** Freshly fetched + verified + stored this pass. */
  readonly replicated: number
  /** A FETCH was attempted but failed (offline / poisoned). Egress; re-tried next pass. */
  readonly failed: number
  /** Can't replicate now WITHOUT a fetch (locked / no key / malformed hash) — FREE, so
   *  it never consumes the budget or blocks the absent tail behind it (§ PRE_FETCH_FAIL_REASONS). */
  readonly unavailable: number
  /** Left unattempted because the per-pass fetch budget was reached — the lazy tail. */
  readonly skipped: number
}

/** Replicate the absent bytes for `requests` (one active workspace's media blocks),
 *  sequential and budget-bounded. See the module header for the politeness model. */
export const reconcileDownLane = async (
  requests: readonly AssetResolveRequest[],
  deps: DownLaneDeps,
): Promise<DownLaneSummary> => {
  const budget = deps.budget ?? DEFAULT_DOWN_LANE_BUDGET
  let present = 0
  let replicated = 0
  let failed = 0
  let unavailable = 0
  let attempts = 0

  for (let i = 0; i < requests.length; i++) {
    const r = await deps.resolver.replicate(requests[i])
    // An already-present block is FREE — a has() probe, no fetch — so it never
    // consumes the budget; the steady state walks the whole workspace for nothing.
    if (r.ok && r.status === 'present') {
      present += 1
      continue
    }
    // A prepare-stage fail-closed (locked / no key / malformed hash) did NO fetch, so
    // it's also FREE: it can't replicate now, but it must not consume the egress budget
    // or block the absent tail behind it (a no-key workspace would otherwise starve).
    if (!r.ok && PRE_FETCH_FAIL_REASONS.has(r.reason)) {
      unavailable += 1
      continue
    }
    // A genuine fetch was attempted — success OR a fetch/verify failure — egress consumed.
    attempts += 1
    if (r.ok) replicated += 1
    else failed += 1
    if (attempts >= budget) {
      return { present, replicated, failed, unavailable, skipped: requests.length - 1 - i }
    }
  }

  return { present, replicated, failed, unavailable, skipped: 0 }
}
