// File-scoped IndexedDB polyfill — sets global `indexedDB`/`IDBKeyRange` for
// this file only (vitest isolates modules per file), so the real IdbKeyedStore
// path runs in Node. We store plain-JSON values here; the CryptoKey consumer
// (keyStore) can only be exercised in a real browser, so it's NOT migrated yet.
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

  it('a write is durable across a "reload" (fresh instance, same DB)', async () => {
    // A brand-new instance has its own connection handle but reopens the same
    // named DB — the row, committed by the `tx` fence, must still be there.
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
})
