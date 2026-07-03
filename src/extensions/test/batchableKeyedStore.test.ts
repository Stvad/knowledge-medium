import {describe, expect, it, vi} from 'vitest'
import {BatchableKeyedStore} from '@/extensions/batchableKeyedStore.js'

/** Minimal concrete store exposing the protected set/delete, standing in for
 *  the real subclasses (ExtensionApprovalStatusStore, ExtensionLoadErrorStore)
 *  whose report/clear are trivial aliases of these. */
class TestStore extends BatchableKeyedStore<string> {
  put = (key: string, value: string): void => this.set(key, value)
  remove = (key: string): void => this.delete(key)
}

describe('BatchableKeyedStore', () => {
  it('set records a value, notifies, and yields a fresh snapshot each call', () => {
    const store = new TestStore('test')
    const listener = vi.fn()
    store.subscribe(listener)

    const before = store.getSnapshot()
    store.put('a', 'x')
    const after = store.getSnapshot()

    expect(after).not.toBe(before)
    expect(after.get('a')).toBe('x')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('delete removes only the given key and notifies; missing key is a no-op', () => {
    const store = new TestStore('test')
    store.put('a', 'x')
    store.put('b', 'y')
    const listener = vi.fn()
    store.subscribe(listener)

    store.remove('a')
    expect(store.getSnapshot().has('a')).toBe(false)
    expect(store.getSnapshot().get('b')).toBe('y')
    expect(listener).toHaveBeenCalledTimes(1)

    const snap = store.getSnapshot()
    store.remove('missing')
    expect(store.getSnapshot()).toBe(snap)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reset clears and notifies; empty store reset is a no-op', () => {
    const store = new TestStore('test')
    store.put('a', 'x')
    const listener = vi.fn()
    store.subscribe(listener)

    store.reset()
    expect(store.getSnapshot().size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(1)

    store.reset()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('batches writes: buffers with no notify until commit, then swaps atomically', () => {
    const store = new TestStore('test')
    store.put('old', 'stale')
    const listener = vi.fn()
    store.subscribe(listener)

    store.beginBatch()
    store.put('a', 'x')
    store.put('b', 'y')

    // Mid-batch: subscribers still see the PREVIOUS complete set, no notify.
    expect(listener).not.toHaveBeenCalled()
    expect([...store.getSnapshot().keys()]).toEqual(['old'])

    store.commitBatch()

    // One notify; the rebuilt set — the un-written 'old' key drops out (same
    // end state as reset()-then-write).
    expect(listener).toHaveBeenCalledTimes(1)
    expect([...store.getSnapshot().keys()].sort()).toEqual(['a', 'b'])
  })

  it('commitBatch with an empty buffer clears the map in one notify', () => {
    const store = new TestStore('test')
    store.put('old', 'stale')
    const listener = vi.fn()
    store.subscribe(listener)

    store.beginBatch()
    store.commitBatch()

    expect(store.getSnapshot().size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('commitBatch with no batch open is a no-op', () => {
    const store = new TestStore('test')
    const listener = vi.fn()
    store.subscribe(listener)

    store.commitBatch()
    expect(listener).not.toHaveBeenCalled()
  })

  it('abandonBatch drops the buffer and returns the store to a live state', () => {
    const store = new TestStore('test')
    store.put('old', 'stale')
    const listener = vi.fn()
    store.subscribe(listener)

    store.beginBatch()
    store.put('a', 'x')
    store.abandonBatch()

    expect([...store.getSnapshot().keys()]).toEqual(['old'])
    expect(listener).not.toHaveBeenCalled()

    // A later commit does nothing; a later write notifies again (the property
    // AppRuntimeProvider's error-path abandonBatch relies on).
    store.commitBatch()
    expect(listener).not.toHaveBeenCalled()
    store.put('c', 'z')
    expect(listener).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().get('c')).toBe('z')
  })

  it('reset abandons an open batch and clears', () => {
    const store = new TestStore('test')
    store.put('old', 'stale')

    store.beginBatch()
    store.put('a', 'x')
    store.reset()

    expect(store.getSnapshot().size).toBe(0)
    const listener = vi.fn()
    store.subscribe(listener)
    store.commitBatch()
    expect(listener).not.toHaveBeenCalled()
  })

  it('subscribe returns an unsubscribe that stops notifications', () => {
    const store = new TestStore('test')
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.put('a', 'x')
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.put('b', 'y')
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
