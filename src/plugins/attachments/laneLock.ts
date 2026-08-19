/**
 * Web Lock helpers for the background byte-replication lanes (design §8/§9). The
 * up-lane drain and the down-lane replicator are SINGLE-OWNER across tabs so N open
 * tabs don't multiply egress; both elect one owner via `navigator.locks`.
 */

/** Run `work` holding a named Web Lock — the lane is single-owner across tabs. A
 *  concurrent caller QUEUES behind the holder (runs after it releases). Falls back to
 *  running directly where `navigator.locks` is absent (tests / older browsers). Used
 *  by the up-lane drain, whose queued duplicate is cheap + idempotent. */
export const withLock = async <T>(name: string, work: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks?.request ? locks.request(name, work) : work()
}

/** Like {@link withLock} but NON-BLOCKING (`ifAvailable`): if another tab already
 *  holds the lane, SKIP this pass instead of queuing behind it. The right call for an
 *  idempotent, periodically-re-armed lane (the down-lane) where a queued duplicate
 *  would only re-walk a workspace the owner already replicated — wasted work, not
 *  wrong. Returns true if `work` ran, false if it was skipped. Runs directly (→ true)
 *  where `navigator.locks` is absent. */
export const runSingleOwner = async (name: string, work: () => Promise<void>): Promise<boolean> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks?.request) {
    await work()
    return true
  }
  return locks.request(name, { ifAvailable: true }, async (lock) => {
    if (!lock) return false // another tab owns the lane this tick — skip
    await work()
    return true
  })
}
