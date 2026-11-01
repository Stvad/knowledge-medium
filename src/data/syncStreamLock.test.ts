import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebStreamingSyncImplementation, type WebStreamingSyncImplementationOptions } from '@powersync/web'
import { isSyncStreamLockHeld, syncStreamLockName } from '@/data/syncStreamLock'

type LockSnapshot = Awaited<ReturnType<LockManager['query']>>

const locksWith = (snapshot: LockSnapshot): Pick<LockManager, 'query'> => ({
  query: async () => snapshot,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('syncStreamLockName', () => {
  it('is the lock PowerSync requests for each streaming iteration', async () => {
    const requested: string[] = []
    vi.stubGlobal('navigator', {
      locks: {
        request: (name: string) => {
          requested.push(name)
          return new Promise(() => {})
        },
      },
    })
    const sync = new WebStreamingSyncImplementation({
      identifier: 'user.db',
      logger: {log: () => {}},
      subscriptions: [],
    } as unknown as WebStreamingSyncImplementationOptions)
    // The iteration is protected; calling it directly reaches the real
    // `obtainLock` with PowerSync's own sync lock type.
    void (sync as unknown as {
      streamingSyncIteration(signal: AbortSignal, options: unknown): Promise<unknown>
    }).streamingSyncIteration(new AbortController().signal, {})

    await vi.waitFor(() => expect(requested).toEqual([syncStreamLockName('user.db')]))
  })
})

describe('isSyncStreamLockHeld', () => {
  it('is true while any client holds this database\'s sync lock', async () => {
    const locks = locksWith({
      held: [{name: syncStreamLockName('user.db'), mode: 'exclusive', clientId: 'other'}],
      pending: [{name: syncStreamLockName('user.db'), mode: 'exclusive', clientId: 'mine'}],
    })

    expect(await isSyncStreamLockHeld('user.db', locks)).toBe(true)
  })

  it('ignores a request that is only queued, and another database\'s lock', async () => {
    const locks = locksWith({
      held: [{name: syncStreamLockName('other-user.db'), mode: 'exclusive', clientId: 'other'}],
      pending: [{name: syncStreamLockName('user.db'), mode: 'exclusive', clientId: 'mine'}],
    })

    expect(await isSyncStreamLockHeld('user.db', locks)).toBe(false)
  })

  it('is false where Web Locks are unavailable', async () => {
    vi.stubGlobal('navigator', {})

    expect(await isSyncStreamLockHeld('user.db')).toBe(false)
  })
})
