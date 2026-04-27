import { describe, expect, it, vi } from 'vitest'
import { ExtensionLoadErrorStore } from '@/extensions/extensionLoadErrors.tsx'

describe('ExtensionLoadErrorStore', () => {
  it('starts empty', () => {
    const store = new ExtensionLoadErrorStore()
    expect(store.getSnapshot().size).toBe(0)
  })

  it('reportError records the error and notifies subscribers', () => {
    const store = new ExtensionLoadErrorStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.reportError('ext-1', new Error('boom'))

    expect(store.getSnapshot().get('ext-1')?.message).toBe('boom')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reportError replaces an existing error for the same blockId', () => {
    const store = new ExtensionLoadErrorStore()
    store.reportError('ext-1', new Error('first'))
    store.reportError('ext-1', new Error('second'))

    expect(store.getSnapshot().size).toBe(1)
    expect(store.getSnapshot().get('ext-1')?.message).toBe('second')
  })

  it('reportError produces a new snapshot reference each call (immutable updates)', () => {
    const store = new ExtensionLoadErrorStore()
    const before = store.getSnapshot()
    store.reportError('ext-1', new Error('x'))
    const after = store.getSnapshot()

    expect(after).not.toBe(before)
    expect(before.size).toBe(0)
    expect(after.size).toBe(1)
  })

  it('clearError removes only the specified entry and notifies', () => {
    const store = new ExtensionLoadErrorStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.reportError('a', new Error('err-a'))
    store.reportError('b', new Error('err-b'))
    listener.mockClear()

    store.clearError('a')

    expect(store.getSnapshot().has('a')).toBe(false)
    expect(store.getSnapshot().get('b')?.message).toBe('err-b')
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('clearError on a missing blockId is a no-op (no notify, no snapshot churn)', () => {
    const store = new ExtensionLoadErrorStore()
    const listener = vi.fn()
    store.subscribe(listener)

    const before = store.getSnapshot()
    store.clearError('does-not-exist')
    const after = store.getSnapshot()

    expect(after).toBe(before)
    expect(listener).not.toHaveBeenCalled()
  })

  it('reset clears all entries and notifies', () => {
    const store = new ExtensionLoadErrorStore()
    const listener = vi.fn()

    store.reportError('a', new Error('err-a'))
    store.reportError('b', new Error('err-b'))
    store.subscribe(listener)

    store.reset()

    expect(store.getSnapshot().size).toBe(0)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('reset on an empty store is a no-op (no notify)', () => {
    const store = new ExtensionLoadErrorStore()
    const listener = vi.fn()
    store.subscribe(listener)

    store.reset()

    expect(listener).not.toHaveBeenCalled()
  })

  it('subscribe returns an unsubscribe that stops further notifications', () => {
    const store = new ExtensionLoadErrorStore()
    const listener = vi.fn()
    const unsubscribe = store.subscribe(listener)

    store.reportError('a', new Error('first'))
    expect(listener).toHaveBeenCalledTimes(1)

    unsubscribe()
    store.reportError('b', new Error('second'))
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
