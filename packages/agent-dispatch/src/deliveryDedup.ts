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
 * here (claim BEFORE dispatching, not after) is invisible from the outside
 * and was wrong for two rounds.
 *
 * Best-effort, and deliberately so. The window is bounded by `max` and the
 * whole set is lost when this process restarts. It covers the sender's
 * retry window, which is the case that occurs; exactly-once across this
 * boundary is not available and pretending otherwise would be worse than
 * the gap.
 */
export const createDeliveryDedup = (max = 500) => {
  const seen = new Set<string>()
  return {
    /** True when this id is ours to dispatch; false when someone already
     *  claimed it. Claiming happens HERE, before the caller awaits delivery:
     *  a claim recorded afterwards leaves the in-flight request unclaimed,
     *  so a retry arriving during a slow dispatch is treated as new. */
    claim: (id: string | undefined): boolean => {
      if (!id) return true          // an unidentified event is never deduplicated
      if (seen.has(id)) return false
      seen.add(id)
      if (seen.size > max) seen.delete(seen.values().next().value as string)
      return true
    },
    get size(): number { return seen.size },
  }
}
