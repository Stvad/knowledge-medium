/**
 * One conversion run per (user, workspace) in this browser profile: a second
 * tab is refused rather than queued behind the first, which may hold the lock
 * for hours.
 */

export type ConversionLockResult<T> = {readonly acquired: true; readonly value: T} | {readonly acquired: false}

/** Runs `run` holding the lock `name`, or reports that another holder has it. */
export type ConversionLock = <T>(name: string, run: () => Promise<T>) => Promise<ConversionLockResult<T>>

export const conversionLockName = (userId: string, workspaceId: string): string =>
  `km-e2ee-conversion:${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`

/** The Web Locks implementation, or null where the browser has none: there the
 *  flow can't keep a second tab out, so it doesn't run. */
export const webConversionLock = (): ConversionLock | null => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (!locks) return null
  return <T>(name: string, run: () => Promise<T>) =>
    locks.request(name, {ifAvailable: true}, async (lock): Promise<ConversionLockResult<T>> =>
      lock === null ? {acquired: false} : {acquired: true, value: await run()})
}
