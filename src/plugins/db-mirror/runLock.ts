/*
 * Cross-tab exclusion for a mirror run.
 *
 * Two tabs of the same app are two independent schedules, so the promise that
 * keeps one tab from overlapping itself says nothing about the other. Overlap
 * is not merely wasteful: the pruner reads an empty copy as residue from a
 * crashed run and deletes it, which — with a second run mid-copy — is that
 * run's live destination. Its writable stream then finishes into a detached
 * file while the run reports success and records the marker, so later runs skip
 * with no copy on disk. The Web Locks API is the primitive for exactly this.
 *
 * `ifAvailable` rather than waiting: a run that is queued behind another tab's
 * multi-gigabyte copy would sit there for minutes and then do the same work
 * again. Not getting the lock means "another tab is already doing it", which is
 * a true and useful thing to report.
 */

/** Per DATABASE, not per origin: a PR preview and production share an origin
 *  but deliberately have separate database files, and a single name would let
 *  one environment's multi-gigabyte copy defer the other's run — including its
 *  manual one — for a whole cadence. */
const lockNameFor = (dbFilename: string): string => `km-db-mirror-run:${dbFilename}`

/** Present in every browser with the File System Access API; the fallback path
 *  exists for jsdom and for a worker without it, where a single realm makes the
 *  lock moot anyway. */
const locks = (): LockManager | undefined => globalThis.navigator?.locks

/**
 * Run `body` while holding the mirror lock, or return `null` at once if
 * another tab holds it.
 */
export const withMirrorRunLock = async <T,>(
  dbFilename: string,
  body: () => Promise<T>,
): Promise<T | null> => {
  const manager = locks()
  if (!manager) return body()
  return manager.request(lockNameFor(dbFilename), {ifAvailable: true}, async lock =>
    lock ? body() : null,
  )
}
