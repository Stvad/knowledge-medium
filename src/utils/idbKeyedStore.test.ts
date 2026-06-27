// File-scoped IndexedDB polyfill — sets global `indexedDB`/`IDBKeyRange` for
// this file only (vitest isolates modules per file), so the real IdbKeyedStore
// path runs in Node. We store plain-JSON values here; keyStore's CryptoKey-bearing
// path can only be exercised in a real browser (browser-validated separately).
import 'fake-indexeddb/auto'

import {afterEach, describe, expect, it, vi} from 'vitest'
import {
  IdbKeyedStore,
  idbKeyPrefix,
  idbRecordId,
  promisifyRequest,
} from './idbKeyedStore.js'

describe('idbRecordId / idbKeyPrefix', () => {
  it('combines owner and id with a `:` delimiter', () => {
    expect(idbRecordId('u', 'w')).toBe('u:w')
    expect(idbKeyPrefix('u')).toBe('u:')
  })

  it('does not alias ids that share a delimiter', () => {
    // enc("a")+":"+enc("b:c") vs enc("a:b")+":"+enc("c") must differ.
    expect(idbRecordId('a', 'b:c')).not.toBe(idbRecordId('a:b', 'c'))
  })

  it("an owner's record id never starts with a sibling owner's prefix", () => {
    // 'abc' must not be reaped by a scan over the 'ab' prefix.
    expect(idbRecordId('abc', 'x').startsWith(idbKeyPrefix('ab'))).toBe(false)
  })
})

describe('IdbKeyedStore', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('round-trips a value and returns undefined for a missing key', async () => {
    const store = new IdbKeyedStore('km-test-rt', 'things')
    await store.tx('readwrite', s => s.put({hello: 'world'}, 'k'))
    expect(await store.tx('readonly', s => s.get('k'))).toEqual({hello: 'world'})
    expect(await store.tx('readonly', s => s.get('missing'))).toBeUndefined()
  })

  it('a write survives a "reload" (fresh instance, same DB)', async () => {
    // A brand-new instance has its own connection handle but reopens the same
    // named DB — the row must still be there. NOTE: this proves cross-instance
    // persistence, NOT the commit fence specifically: fake-indexeddb persists at a
    // request's `onsuccess`, so this would pass even if `tx` resolved on
    // `onsuccess` instead of the tx `oncomplete`. The fence's observable behavior
    // (reject on abort) is covered below; its navigation-durability guarantee is
    // only distinguishable in a real browser.
    const writer = new IdbKeyedStore('km-test-reload', 'things')
    await writer.tx('readwrite', s => s.put({v: 'PERSISTED'}, 'k'))

    const reader = new IdbKeyedStore('km-test-reload', 'things')
    expect(await reader.tx('readonly', s => s.get('k'))).toEqual({v: 'PERSISTED'})
  })

  it('rejects the commit fence when the transaction aborts', async () => {
    const store = new IdbKeyedStore('km-test-abort', 'things')
    const {store: s, committed} = await store.openTransaction('readwrite')
    // Abort with no pending request, so we hit the onabort path cleanly (a
    // pending request's bubbled error would instead trip onerror — still a
    // rejection, but a different branch).
    s.transaction.abort()
    await expect(committed).rejects.toThrow(/aborted/i)
  })

  it('does not cache a rejected open: a later op retries a fresh open', async () => {
    const store = new IdbKeyedStore('km-test-reject', 'things')
    const realOpen = indexedDB.open.bind(indexedDB)
    let calls = 0
    vi.spyOn(indexedDB, 'open').mockImplementation((...args: Parameters<typeof realOpen>) => {
      calls += 1
      if (calls === 1) throw new Error('open boom')
      return realOpen(...args)
    })

    // First op fails on the rejected open...
    await expect(store.tx('readonly', s => s.get('k'))).rejects.toThrow('open boom')
    // ...and because the rejected promise wasn't cached, the next op opens fresh.
    await store.tx('readwrite', s => s.put({v: 2}, 'k'))
    expect(await store.tx('readonly', s => s.get('k'))).toEqual({v: 2})
    expect(calls).toBeGreaterThanOrEqual(2)
  })

  it('openTransaction gives raw store access for cursor scans + a commit fence', async () => {
    const store = new IdbKeyedStore('km-test-cursor', 'things')
    await store.tx('readwrite', s => s.put({n: 1}, idbRecordId('u', 'a')))
    await store.tx('readwrite', s => s.put({n: 2}, idbRecordId('u', 'b')))
    await store.tx('readwrite', s => s.put({n: 3}, idbRecordId('other', 'a')))

    const prefix = idbKeyPrefix('u')
    const {store: s, committed} = await store.openTransaction('readonly')
    const keys: string[] = []
    await new Promise<void>((resolve, reject) => {
      const request = s.openCursor()
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) {
          resolve()
          return
        }
        if (typeof cursor.key === 'string' && cursor.key.startsWith(prefix)) {
          keys.push(cursor.key)
        }
        cursor.continue()
      }
      request.onerror = () => reject(request.error)
    })
    await committed

    // Only the 'u'-owned records, never 'other' (sibling-prefix safe).
    expect(keys.sort()).toEqual([idbRecordId('u', 'a'), idbRecordId('u', 'b')].sort())
  })

  it('promisifyRequest rejects on a request error', async () => {
    const store = new IdbKeyedStore('km-test-promisify', 'things')
    await store.tx('readwrite', s => s.put({}, 'dup'))
    const {store: s, committed} = await store.openTransaction('readwrite')
    // `add` on an existing key fails with a ConstraintError on the request —
    // promisifyRequest must surface it as a rejection, not hang.
    await expect(promisifyRequest(s.add({}, 'dup'))).rejects.toBeTruthy()
    await committed.catch(() => {}) // the failed add aborts the tx
  })

  it('runTransaction surfaces a body rejection and does not leak the commit fence', async () => {
    // A duplicate-key `add` rejects the body's request AND aborts the tx, so the
    // commit fence rejects too. runTransaction must rethrow the body error and
    // observe the fence's rejection itself — note we do NOT catch any fence here
    // (unlike the raw openTransaction test above); if it leaked, vitest would
    // flag an unhandled rejection.
    const store = new IdbKeyedStore('km-test-rt-leak', 'things')
    await store.tx('readwrite', s => s.put({}, 'dup'))
    await expect(
      store.runTransaction('readwrite', s => promisifyRequest(s.add({}, 'dup'))),
    ).rejects.toBeTruthy()
  })

  it('deleteByPrefix removes only the owner\'s records (sibling-prefix safe)', async () => {
    const store = new IdbKeyedStore('km-test-delprefix', 'things')
    await store.tx('readwrite', s => s.put({n: 1}, idbRecordId('u', 'a')))
    await store.tx('readwrite', s => s.put({n: 2}, idbRecordId('u', 'b')))
    // 'uX' shares 'u' as a textual prefix but is a DIFFERENT owner — the
    // `:`-delimited prefix must not reap it (the invariant clearForUser relies on).
    await store.tx('readwrite', s => s.put({n: 3}, idbRecordId('uX', 'a')))

    await store.deleteByPrefix(idbKeyPrefix('u'))

    expect(await store.tx('readonly', s => s.get(idbRecordId('u', 'a')))).toBeUndefined()
    expect(await store.tx('readonly', s => s.get(idbRecordId('u', 'b')))).toBeUndefined()
    expect(await store.tx('readonly', s => s.get(idbRecordId('uX', 'a')))).toEqual({n: 3})
  })
})
