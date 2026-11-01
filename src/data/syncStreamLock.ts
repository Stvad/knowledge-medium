/**
 * The Web Lock PowerSync's web client holds for each streaming sync iteration
 * (`WebStreamingSyncImplementation.obtainLock`, lock type `sync`, identified
 * by the database file), so one sync loop per database streams at a time on
 * this origin. Tabs on one build share a SharedWorker and so one loop; each
 * build runs its own worker, and a browser without SharedWorker runs one loop
 * per tab. A loop queued behind another holder reports neither connected nor
 * connecting, and no error.
 */
export const syncStreamLockName = (dbFilename: string): string =>
  `streaming-sync-sync-${dbFilename}`

const navigatorLocks = (): Pick<LockManager, 'query'> | undefined =>
  typeof navigator !== 'undefined' ? navigator.locks : undefined

/** Whether some client on this origin holds `dbFilename`'s sync stream lock.
 *  A queued request is not a hold. False where Web Locks are unavailable. */
export const isSyncStreamLockHeld = async (
  dbFilename: string,
  locks: Pick<LockManager, 'query'> | undefined = navigatorLocks(),
): Promise<boolean> => {
  if (!locks) return false
  const name = syncStreamLockName(dbFilename)
  const {held = []} = await locks.query()
  return held.some(lock => lock.name === name)
}
