// @vitest-environment jsdom
/**
 * Cache round-trip tests. Verify per-workspace scoping, empty-map
 * handling, decode tolerance to malformed input, and that the keying
 * convention can't collide across workspaces.
 */
import {beforeEach, describe, expect, it} from 'vitest'
import {ClientLocalSettings} from '@/utils/ClientLocalSettings.js'
import {
  decodeOverrides,
  encodeOverrides,
  readOverridesCache,
  writeOverridesCache,
} from '@/extensions/overridesCache.js'
import type {Overrides} from '@/facets/togglable.js'

class MemoryStorage implements Storage {
  private store = new Map<string, string>()
  get length(): number { return this.store.size }
  clear(): void { this.store.clear() }
  getItem(key: string): string | null { return this.store.get(key) ?? null }
  setItem(key: string, value: string): void { this.store.set(key, value) }
  removeItem(key: string): void { this.store.delete(key) }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null
  }
}

describe('overridesCache', () => {
  let storage: ClientLocalSettings
  let underlying: MemoryStorage

  beforeEach(() => {
    underlying = new MemoryStorage()
    storage = new ClientLocalSettings(underlying as unknown as Storage)
  })

  it('round-trips a populated overrides map per workspace', () => {
    const ws = 'ws-a'
    const overrides: Overrides = new Map([
      ['system:vim-normal-mode', false],
      ['system:experimental-graph', true],
    ])

    writeOverridesCache(ws, overrides, storage)
    const restored = readOverridesCache(ws, storage)

    expect(restored.get('system:vim-normal-mode')).toBe(false)
    expect(restored.get('system:experimental-graph')).toBe(true)
    expect(restored.size).toBe(2)
  })

  it('returns an empty map when the workspace has no cache yet', () => {
    expect(readOverridesCache('fresh-ws', storage).size).toBe(0)
  })

  it('isolates workspaces — writing one does not affect the other', () => {
    writeOverridesCache('ws-a', new Map([['x', false]]), storage)
    writeOverridesCache('ws-b', new Map([['y', false]]), storage)

    expect(readOverridesCache('ws-a', storage).has('y')).toBe(false)
    expect(readOverridesCache('ws-b', storage).has('x')).toBe(false)
  })

  it('ignores non-boolean values in the stored shape', () => {
    underlying.setItem(
      'extensions.overrides.ws-a',
      JSON.stringify({
        'system:a': false,
        'system:bad-string': 'no',
        'system:bad-null': null,
      }),
    )

    const restored = readOverridesCache('ws-a', storage)
    expect(restored.get('system:a')).toBe(false)
    expect(restored.has('system:bad-string')).toBe(false)
    expect(restored.has('system:bad-null')).toBe(false)
  })

  it('returns an empty map when the stored value is malformed JSON', () => {
    underlying.setItem('extensions.overrides.ws-a', 'not-json')
    expect(readOverridesCache('ws-a', storage).size).toBe(0)
  })

  it('returns an empty map when the stored value is the wrong shape', () => {
    underlying.setItem('extensions.overrides.ws-a', JSON.stringify([1, 2, 3]))
    expect(readOverridesCache('ws-a', storage).size).toBe(0)
  })

  describe('encode/decode (unit)', () => {
    it('encodes an empty map to an empty object', () => {
      expect(encodeOverrides(new Map())).toEqual({})
    })

    it('decodes null / undefined to an empty map', () => {
      expect(decodeOverrides(null).size).toBe(0)
      expect(decodeOverrides(undefined).size).toBe(0)
    })
  })
})
