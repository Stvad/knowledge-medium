import { describe, expect, it, vi } from 'vitest'
import { ExtensionLoadErrorStore } from '@/extensions/extensionLoadErrors.js'

describe('ExtensionLoadErrorStore', () => {
  // Snapshot, reset, subscribe and batch mechanics are the shared base's, covered
  // in batchableKeyedStore.test.ts; these pin this subclass's reportError/clearError.
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
})
