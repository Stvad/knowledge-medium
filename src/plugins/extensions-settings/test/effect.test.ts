// @vitest-environment jsdom
/**
 * Effect reconciliation tests.
 *
 * The full subscription wiring (Block.subscribe + cleanup) is too
 * coupled to Repo to be testable here without a real repo. Instead
 * we drive the extracted `reconcileOverrides` + `readOverridesFromBlock`
 * helpers, which carry the interesting policy:
 *
 *   - decode failures → fallback to empty + console.error (no throw)
 *   - cache write + refresh dispatched only on divergence
 *   - identical maps → no-op
 */
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  reconcileOverrides,
  readOverridesFromBlock,
} from '@/plugins/extensions-settings/effect.js'
import {
  extensionsOverridesProp,
} from '@/plugins/extensions-settings/config.js'
import {writeOverridesCache} from '@/extensions/overridesCache.js'
import type {Overrides} from '@/facets/togglable.js'

/** Build a stub block whose `peekProperty(extensionsOverridesProp)`
 *  returns the supplied value (or throws). Other properties return
 *  undefined. */
const makeBlock = (
  overridesOrError: Overrides | Error,
) => ({
  peekProperty(schema: typeof extensionsOverridesProp): Overrides | undefined {
    if (schema !== extensionsOverridesProp) return undefined
    if (overridesOrError instanceof Error) throw overridesOrError
    return overridesOrError
  },
})

describe('readOverridesFromBlock', () => {
  it('returns the block-stored overrides when present', () => {
    const overrides: Overrides = new Map([['system:a', false]])
    const block = makeBlock(overrides)
    expect(readOverridesFromBlock(block)).toBe(overrides)
  })

  it('returns an empty map when peekProperty throws (codec failure)', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const block = makeBlock(new Error('codec mismatch'))
      const result = readOverridesFromBlock(block)
      expect(result.size).toBe(0)
      expect(error).toHaveBeenCalledTimes(1)
    } finally {
      error.mockRestore()
    }
  })

  it('returns an empty map when the property is unset (peekProperty returns undefined)', () => {
    const block = {peekProperty: () => undefined}
    expect(readOverridesFromBlock(block).size).toBe(0)
  })
})

describe('reconcileOverrides', () => {
  // Use the shared singleton clientLocalSettings so the production
  // read/writeOverridesCache helpers (which default to it) see the
  // same backing storage as the test. The window's localStorage is
  // provided by happy-dom and reset between tests below.
  beforeEach(() => {
    localStorage.clear()
  })
  afterEach(() => {
    localStorage.clear()
  })

  it('writes the cache and dispatches refresh when the block diverges from cache', () => {
    const dispatch = vi.fn()
    const ws = 'ws-a'
    const overrides: Overrides = new Map([['system:vim', false]])
    const block = makeBlock(overrides)

    const refreshed = reconcileOverrides(ws, block, dispatch)

    expect(refreshed).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    // localStorage now holds the new map
    const stored = localStorage.getItem(`extensions.overrides.${ws}`)
    expect(JSON.parse(stored ?? 'null')).toEqual({'system:vim': false})
  })

  it('is a no-op when the block and cache are identical', () => {
    const ws = 'ws-b'
    writeOverridesCache(ws, new Map([['system:vim', false]]))

    const dispatch = vi.fn()
    const block = makeBlock(new Map([['system:vim', false]]))

    const refreshed = reconcileOverrides(ws, block, dispatch)

    expect(refreshed).toBe(false)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('detects entry-value differences (override flipped)', () => {
    const ws = 'ws-c'
    writeOverridesCache(ws, new Map([['system:vim', false]]))

    const dispatch = vi.fn()
    const block = makeBlock(new Map([['system:vim', true]]))

    expect(reconcileOverrides(ws, block, dispatch)).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('detects size differences (override added)', () => {
    const ws = 'ws-d'
    writeOverridesCache(ws, new Map([['system:vim', false]]))

    const dispatch = vi.fn()
    const block = makeBlock(new Map([
      ['system:vim', false],
      ['system:emacs', false],
    ]))

    expect(reconcileOverrides(ws, block, dispatch)).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('detects size differences (override removed)', () => {
    const ws = 'ws-e'
    writeOverridesCache(ws, new Map([
      ['system:vim', false],
      ['system:emacs', false],
    ]))

    const dispatch = vi.fn()
    const block = makeBlock(new Map([['system:vim', false]]))

    expect(reconcileOverrides(ws, block, dispatch)).toBe(true)
  })

  it('writes an empty map and refreshes when all overrides are cleared', () => {
    const ws = 'ws-f'
    writeOverridesCache(ws, new Map([['system:vim', false]]))

    const dispatch = vi.fn()
    const block = makeBlock(new Map())

    expect(reconcileOverrides(ws, block, dispatch)).toBe(true)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(`extensions.overrides.${ws}`) ?? 'null'))
      .toEqual({})
  })

  it('falls back to empty when peekProperty throws and treats cache miss as no-op', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const ws = 'ws-g'
      // No prior cache entry → readOverridesCache returns empty map.
      // Block throws → readOverridesFromBlock returns empty map.
      // Equal → no dispatch.
      const dispatch = vi.fn()
      const block = makeBlock(new Error('boom'))

      expect(reconcileOverrides(ws, block, dispatch)).toBe(false)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})
