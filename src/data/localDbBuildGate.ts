/**
 * One app build per local database at a time.
 *
 * Tabs share the database file but each runs its own copy of the app, and a
 * deploy can change what the file holds (the PowerSync core schema, the
 * client schema's triggers). A tab of the previous build writing beside the
 * new one can fail its writes, and one that boots beside it can migrate the
 * file back down. So a tab opens the database only once no tab of a DIFFERENT
 * build holds it. The previous build's tabs leave by themselves: the new
 * service worker taking over makes each reload at its first safe moment
 * (src/appUpdate.ts). The wait is what makes that safe while one of them is
 * still being edited.
 *
 * Every admitted tab holds a shared Web Lock named for (database, build) for
 * its whole life. To be admitted, a tab asks for each other build's name
 * exclusively, which the lock manager grants only once every holder has
 * unloaded, and only then takes its own. Admission is one tab at a time per
 * database, so a waiting tab holds no build lock: two builds starting together
 * cannot each wait on the other.
 */
import { appVersion } from '@/appVersion.js'
import { CallbackSet } from '@/utils/callbackSet.js'

const LOCK_PREFIX = 'km-db-build:'

export const localDbBuildLockName = (dbFilename: string, buildId: string): string =>
  `${LOCK_PREFIX}${dbFilename}|${buildId}`

const admissionLockName = (dbFilename: string): string => `km-db-build-admission:${dbFilename}`

/** The part of `navigator.locks` the gate uses. */
export interface GateLocks {
  request<T>(name: string, options: LockOptions, callback: (lock: Lock | null) => T): Promise<Awaited<T>>
  query(): Promise<LockManagerSnapshot>
}

export const createLocalDbBuildGate = (locks: GateLocks | undefined) => {
  const entered = new Map<string, Promise<void>>()
  const listeners = new CallbackSet('localDbBuildGate')
  let waiting = false

  const setWaiting = (next: boolean): void => {
    if (waiting === next) return
    waiting = next
    listeners.notify()
  }

  const holdForPageLife = (name: string): Promise<void> =>
    new Promise((granted, failed) => {
      locks!.request(name, {mode: 'shared'}, () => {
        granted()
        return new Promise<never>(() => {})
      }).catch(failed)
    })

  const otherBuilds = async (dbFilename: string, own: string): Promise<string[]> => {
    const prefix = localDbBuildLockName(dbFilename, '')
    const {held = []} = await locks!.query()
    const names = held.map(lock => lock.name).filter((name): name is string =>
      name !== undefined && name.startsWith(prefix) && name !== own)
    return [...new Set(names)]
  }

  const enter = (dbFilename: string, buildId: string): Promise<void> =>
    locks!.request(admissionLockName(dbFilename), {mode: 'exclusive'}, async () => {
      const own = localDbBuildLockName(dbFilename, buildId)
      // One pass: build locks are only taken under admission, which we hold.
      const others = await otherBuilds(dbFilename, own)
      if (others.length > 0) setWaiting(true)
      for (const name of others) await locks!.request(name, {mode: 'exclusive'}, () => undefined)
      await holdForPageLife(own)
    })

  return {
    /** Resolves once this tab may open `dbFilename`. */
    enter(dbFilename: string, buildId: string): Promise<void> {
      if (!locks) return Promise.resolve()
      let promise = entered.get(dbFilename)
      if (!promise) {
        // Fails open: a boot that cannot reach the lock manager opening
        // unguarded beats one that never opens.
        promise = enter(dbFilename, buildId)
          .catch((error: unknown) => console.warn('[localDbBuildGate] opening without the build gate:', error))
          .finally(() => setWaiting(false))
        entered.set(dbFilename, promise)
      }
      return promise
    },
    isWaiting: (): boolean => waiting,
    subscribe: (listener: () => void): (() => void) => listeners.add(listener),
  }
}

export const localDbBuildGate = createLocalDbBuildGate(
  typeof navigator === 'undefined' ? undefined : navigator.locks,
)

/** Waits until no tab of another build has `dbFilename` open. */
export const enterLocalDbBuildGate = (dbFilename: string): Promise<void> =>
  localDbBuildGate.enter(dbFilename, appVersion.sha)
