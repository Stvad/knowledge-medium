/**
 * "Has my claim been resolved by the server yet?" — the wait a per-graph
 * backfill claim needs before its re-read means anything.
 *
 * `onSyncSettled` cannot answer this, and reusing it here was a real bug. Its
 * predicate is `connected && !downloading && !downloadError`, which inspects
 * the DOWNLOAD flow only: right after writing a claim the device is connected
 * with nothing downloading, so it fires synchronously and waits for nothing.
 * The re-read then returns the device's own row — and worse, it is guaranteed
 * to: `decideStagingRow` refuses an arriving row while `local.hasPendingUpload`
 * (`syncObserver/reconcile.ts`), so the winner cannot land until this device's
 * own create has flushed. The one event that could change the answer was
 * blocked exactly as long as the old gate declined to wait for it.
 *
 * The two conditions that DO mean something, in order:
 *
 *  1. **Our claim left the upload queue.** `ps_crud` no longer holds a row for
 *     this block id, so the server has our write and has resolved it against
 *     any peer's write to the same id.
 *  2. **A checkpoint has since arrived.** `lastSyncedAt` advanced past the
 *     moment (1) became true, so we have downloaded the server's answer.
 *
 * After both, the local row IS the server's decision, and `decideClaim` on it
 * is a real decision rather than an echo. A peer who uploads later reads our
 * row and backs off; a peer who uploaded earlier is who we now see. Exactly
 * one proceeds.
 *
 * Bounded, and a timeout means BACK OFF, never proceed. Not running is a
 * deferral the next workspace open retries; running unconverged is the
 * duplicated upload-carrying pass the claim exists to prevent — so the two
 * outcomes are not symmetric and the fallback must be the safe one.
 */

export interface ClaimConvergenceDeps {
  /** Is this block still queued for upload? */
  hasPendingUpload: (blockId: string) => Promise<boolean>
  /** Server checkpoint marker; `null` when nothing has synced yet. Advances
   *  when a download checkpoint completes. */
  lastSyncedAt: () => number | null
  /** Subscribe to sync-status changes. Returns a disposer. */
  onStatusChange: (cb: () => void) => () => void
  now: () => number
  /** Give up (and back off) after this long. */
  timeoutMs: number
  /** How often to re-probe when no status change arrives. */
  pollMs: number
  /** Sleep helper, injectable so tests drive time. */
  sleep: (ms: number) => Promise<void>
}

/** True when the local claim row can be trusted as the server's answer. */
export const awaitClaimConverged = async (
  deps: ClaimConvergenceDeps,
  claimId: string,
): Promise<boolean> => {
  const deadline = deps.now() + deps.timeoutMs
  let wake: (() => void) | null = null
  const dispose = deps.onStatusChange(() => { wake?.() })
  try {
    // Phase 1 — our write reaches the server.
    while (await deps.hasPendingUpload(claimId)) {
      if (deps.now() >= deadline) return false
      await raceWake(deps, ms => { wake = ms })
    }
    // Phase 2 — a checkpoint lands AFTER it did. Captured here, not at entry:
    // a checkpoint that completed while we were still uploading cannot carry
    // the server's answer to our own claim.
    const uploadedAt = deps.lastSyncedAt()
    while (true) {
      const seen = deps.lastSyncedAt()
      if (seen !== null && (uploadedAt === null || seen > uploadedAt)) return true
      if (deps.now() >= deadline) return false
      await raceWake(deps, ms => { wake = ms })
    }
  } finally {
    dispose()
  }
}

/** Wait for the next status change or the poll interval, whichever first —
 *  polling because `lastSyncedAt` can advance without a status event, and a
 *  status listener alone would stall until an unrelated change. */
const raceWake = async (
  deps: Pick<ClaimConvergenceDeps, 'sleep' | 'pollMs'>,
  register: (wake: () => void) => void,
): Promise<void> => {
  await new Promise<void>(resolve => {
    let done = false
    const finish = (): void => { if (!done) { done = true; resolve() } }
    register(finish)
    void deps.sleep(deps.pollMs).then(finish)
  })
}
