/**
 * Remembers which channel deliveries have already been dispatched.
 *
 * The listener hands an event to the ambient session and only then answers
 * the sender, so a lost acknowledgement is indistinguishable from a lost
 * delivery — and the sender's retry would otherwise run billed,
 * write-capable work a second time. Claiming the id is what makes that
 * retry safe.
 *
 * Its own module for a seam a test can drive: the ordering that matters
 * here (claim BEFORE dispatching, not after) is invisible from the outside.
 *
 * Best-effort, and deliberately so. The window is bounded by `max` and the
 * whole set is lost when this process restarts. It covers the sender's
 * retry window, which is the case that occurs; exactly-once across this
 * boundary is not available and pretending otherwise would be worse than
 * the gap.
 */
export type ClaimOutcome =
  /** Nobody has this id; the caller should dispatch it. */
  | 'dispatch'
  /** A previous dispatch COMPLETED. Safe to report as a duplicate: the work
   *  is with the session, so the sender may treat its delivery as done. */
  | 'delivered'
  /** Someone holds this id but has not confirmed delivery — still in flight,
   *  or it failed. NOT a duplicate the sender may bank on. */
  | 'unconfirmed'

export const createDeliveryDedup = (max = 500) => {
  // Three states, not two. A Set can only say "seen", which conflated "the
  // session has this" with "someone tried and we do not know" — and a query
  // sender told `duplicate` treats the delivery as done, bumps its
  // generation and advances its cursor, dropping rows nothing ever ran.
  // Unlike a mention there is no block left behind for a stale sweep to
  // find, so those rows are simply gone.
  const claims = new Map<string, 'pending' | 'delivered'>()
  const remember = (id: string, state: 'pending' | 'delivered') => {
    claims.set(id, state)
    // Oldest-first eviction; Map preserves insertion order.
    if (claims.size > max) claims.delete(claims.keys().next().value as string)
  }
  return {
    /** Claim an id for dispatch. Claiming happens HERE, before the caller
     *  awaits delivery: a claim recorded afterwards leaves the in-flight
     *  request unclaimed, so a retry arriving during a slow dispatch is
     *  treated as new work. */
    claim: (id: string | undefined): ClaimOutcome => {
      if (!id) return 'dispatch'   // an unidentified event is never deduplicated
      const held = claims.get(id)
      if (held === 'delivered') return 'delivered'
      if (held === 'pending') return 'unconfirmed'
      remember(id, 'pending')
      return 'dispatch'
    },
    /** The dispatch completed — from here a repeat is a true duplicate. */
    confirm: (id: string | undefined) => { if (id) remember(id, 'delivered') },
    /** The dispatch failed before reaching the session. Releasing the claim
     *  lets a retry through; only call it when nothing can have been
     *  delivered, since a release after delivery runs the work twice. */
    release: (id: string | undefined) => { if (id) claims.delete(id) },
    get size(): number { return claims.size },
  }
}
