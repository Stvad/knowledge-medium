// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getClientId, resetClientIdCache } from '../clientId'

describe('getClientId', () => {
  beforeEach(() => { resetClientIdCache() })
  afterEach(() => { vi.unstubAllGlobals(); resetClientIdCache() })

  it('returns a stable id within a session even without localStorage', () => {
    vi.stubGlobal('localStorage', undefined)
    const id = getClientId()
    expect(id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(getClientId()).toBe(id)
  })

  it('persists to localStorage and reuses the stored id across a fresh load', () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v) },
    })
    const first = getClientId()
    expect(store.get('km:client-id')).toBe(first)
    resetClientIdCache() // simulate a reload with the same storage
    expect(getClientId()).toBe(first)
  })

  it('falls back to a session-stable id when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked') },
      setItem: () => { throw new Error('blocked') },
    })
    const id = getClientId()
    expect(getClientId()).toBe(id) // cached, stable despite no persistence
  })
})
