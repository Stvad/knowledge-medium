import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ClientLocalSettings } from '@/utils/ClientLocalSettings.js'
import { keybindingOverridesProp } from '../config.ts'
import {
  readOverridesFromBlock,
  reconcileOverrides,
} from '../effect.ts'
import {
  readKeybindingOverridesCache,
  writeKeybindingOverridesCache,
} from '../overridesCache.ts'

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length() { return this.store.size }
  key(index: number) { return [...this.store.keys()][index] ?? null }
  getItem(key: string) { return this.store.get(key) ?? null }
  setItem(key: string, value: string) { this.store.set(key, value) }
  removeItem(key: string) { this.store.delete(key) }
  clear() { this.store.clear() }
}

const makeStorageStub = (): ClientLocalSettings => new ClientLocalSettings(new MemoryStorage())

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('readOverridesFromBlock', () => {
  it('returns the property value when the codec succeeds', () => {
    const block = {
      peekProperty: vi.fn().mockReturnValue([
        {actionId: 'demo', context: 'normal-mode', binding: {keys: 'cmd+k'}},
      ]),
    }
    const out = readOverridesFromBlock(block as never)
    expect(block.peekProperty).toHaveBeenCalledWith(keybindingOverridesProp)
    expect(out).toEqual([
      {actionId: 'demo', context: 'normal-mode', binding: {keys: 'cmd+k'}},
    ])
  })

  it('returns [] when the codec throws (malformed snapshot)', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const block = {
      peekProperty: vi.fn().mockImplementation(() => {
        throw new Error('boom')
      }),
    }
    expect(readOverridesFromBlock(block as never)).toEqual([])
    expect(consoleSpy).toHaveBeenCalled()
  })

  it('returns [] when the property is unset', () => {
    const block = {peekProperty: vi.fn().mockReturnValue(undefined)}
    expect(readOverridesFromBlock(block as never)).toEqual([])
  })
})

describe('reconcileOverrides', () => {
  it('writes the cache and dispatches when the block diverges', () => {
    // We pass a stub storage into the cache helpers below; this test
    // injects its own dispatch and uses the default cache backing
    // (which we pre-seed via writeKeybindingOverridesCache with a
    // distinct storage). To keep the harness simple, we instead
    // assert the dispatch behaviour with the default storage and
    // clear it between runs.
    const storage = makeStorageStub()
    writeKeybindingOverridesCache('ws-1', [], storage)
    const block = {
      peekProperty: vi.fn().mockReturnValue([
        {actionId: 'a', context: 'normal-mode', binding: {keys: 'cmd+k'}},
      ]),
    }
    // The real reconcile uses the default ClientLocalSettings; we
    // accept that coupling and just reset between tests.
    const dispatch = vi.fn()
    const refreshed = reconcileOverrides('ws-reconcile-1', block as never, dispatch)
    expect(refreshed).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(readKeybindingOverridesCache('ws-reconcile-1')).toEqual([
      {actionId: 'a', context: 'normal-mode', binding: {keys: 'cmd+k'}},
    ])
  })

  it('does NOT dispatch when the block matches the cache exactly', () => {
    const block = {
      peekProperty: vi.fn().mockReturnValue([
        {actionId: 'a', context: 'normal-mode', binding: {keys: 'cmd+k'}},
      ]),
    }
    // First reconcile primes the cache.
    reconcileOverrides('ws-reconcile-2', block as never, vi.fn())
    const dispatch = vi.fn()
    const refreshed = reconcileOverrides('ws-reconcile-2', block as never, dispatch)
    expect(refreshed).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })
})
