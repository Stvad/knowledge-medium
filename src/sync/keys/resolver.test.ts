// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryWorkspaceKeyStore } from './keyStore.js'
import { setModePin } from './modePin.js'
import { createSyncResolver } from './resolver.js'

const USER = 'user-1'
const WS = 'ws-A'

// The resolver only checks the key for presence (truthiness) and hands it to
// the seam unchanged, so sentinels stand in for real non-extractable
// CryptoKeys — the crypto round-trip is exercised in transform/aead tests.
const FAKE_KEY = {} as CryptoKey
const FAKE_HMAC = { name: 'k_id' } as unknown as CryptoKey
const record = (wk: CryptoKey, contentKeyHmac: CryptoKey | null = null) => ({ wk, contentKeyHmac })

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

const build = (userId: string | null = USER) => {
  const keyStore = new InMemoryWorkspaceKeyStore()
  const resolver = createSyncResolver(() => userId, keyStore)
  return { keyStore, resolver }
}

describe('createSyncResolver — getMaterializability (§6 policy collapse)', () => {
  it('plaintext pin → copy (no key needed)', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'plaintext')
    expect(await resolver.getMaterializability(WS)).toBe('copy')
  })

  it('e2ee pin with WK loaded → decrypt', async () => {
    const { resolver, keyStore } = build()
    setModePin(USER, WS, 'e2ee')
    await keyStore.put(USER, WS, record(FAKE_KEY))
    expect(await resolver.getMaterializability(WS)).toBe('decrypt')
  })

  it('e2ee pin without WK → defer (locked, read-only — §6 rule 3)', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'e2ee')
    expect(await resolver.getMaterializability(WS)).toBe('defer')
  })

  it('unpinned (first-encounter) → defer, never materialized until a flow pins it', async () => {
    const { resolver } = build()
    expect(await resolver.getMaterializability(WS)).toBe('defer')
  })

  it('signed-out (no user id) → defer (fail safe)', async () => {
    const { resolver } = build(null)
    expect(await resolver.getMaterializability(WS)).toBe('defer')
  })

  it('defers (never throws) when the key store read fails for an e2ee pin', async () => {
    // getMaterializability runs outside the observer's per-row decode try/catch,
    // so a throw here would wedge the whole drain. An unreadable store → defer.
    const throwingStore = {
      get: async () => {
        throw new Error('IndexedDB unavailable')
      },
      put: async () => {},
      delete: async () => {},
      clearForUser: async () => {},
    }
    const resolver = createSyncResolver(() => USER, throwingStore)
    setModePin(USER, WS, 'e2ee')
    await expect(resolver.getMaterializability(WS)).resolves.toBe('defer')
  })
})

describe('createSyncResolver — getCek', () => {
  it('returns the stored workspace key (the record WK), not the whole record', async () => {
    const { resolver, keyStore } = build()
    await keyStore.put(USER, WS, record(FAKE_KEY, FAKE_HMAC))
    expect(await resolver.getCek(WS)).toBe(FAKE_KEY)
  })

  it('returns null when no key is stored', async () => {
    const { resolver } = build()
    expect(await resolver.getCek(WS)).toBeNull()
  })

  it('returns null when signed out without touching the store', async () => {
    const { resolver } = build(null)
    expect(await resolver.getCek(WS)).toBeNull()
  })

  it('scopes the lookup to the current user', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    await keyStore.put('other-user', WS, record(FAKE_KEY))
    const resolver = createSyncResolver(() => USER, keyStore)
    expect(await resolver.getCek(WS)).toBeNull()
  })

  it('returns null (does not throw) when the key store read fails', async () => {
    const throwingStore = {
      get: async () => {
        throw new Error('boom')
      },
      put: async () => {},
      delete: async () => {},
      clearForUser: async () => {},
    }
    const resolver = createSyncResolver(() => USER, throwingStore)
    await expect(resolver.getCek(WS)).resolves.toBeNull()
  })
})

describe('createSyncResolver — getContentKeyHmac (§10 asset path)', () => {
  it('returns the record K_id when present', async () => {
    const { resolver, keyStore } = build()
    await keyStore.put(USER, WS, record(FAKE_KEY, FAKE_HMAC))
    expect(await resolver.getContentKeyHmac(WS)).toBe(FAKE_HMAC)
  })

  it('returns null for a LEGACY record (WK present, no K_id) → media fails closed', async () => {
    const { resolver, keyStore } = build()
    await keyStore.put(USER, WS, record(FAKE_KEY, null))
    // WK still resolves (text works) but K_id is absent (media fail-closed) —
    // the §10 re-paste migration state.
    expect(await resolver.getCek(WS)).toBe(FAKE_KEY)
    expect(await resolver.getContentKeyHmac(WS)).toBeNull()
  })

  it('returns null when no record is stored', async () => {
    const { resolver } = build()
    expect(await resolver.getContentKeyHmac(WS)).toBeNull()
  })

  it('returns null when signed out without touching the store', async () => {
    const { resolver } = build(null)
    expect(await resolver.getContentKeyHmac(WS)).toBeNull()
  })

  it('returns null (does not throw) when the key store read fails', async () => {
    const throwingStore = {
      get: async () => {
        throw new Error('boom')
      },
      put: async () => {},
      delete: async () => {},
      clearForUser: async () => {},
    }
    const resolver = createSyncResolver(() => USER, throwingStore)
    await expect(resolver.getContentKeyHmac(WS)).resolves.toBeNull()
  })
})

describe('createSyncResolver — getMode (encrypt-on-upload)', () => {
  it('e2ee pin → e2ee', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'e2ee')
    expect(await resolver.getMode(WS)).toBe('e2ee')
  })

  it('plaintext pin → none', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'plaintext')
    expect(await resolver.getMode(WS)).toBe('none')
  })

  it('unpinned → none (never encrypts an unpinned workspace)', async () => {
    const { resolver } = build()
    expect(await resolver.getMode(WS)).toBe('none')
  })

  it('signed-out → none', async () => {
    const { resolver } = build(null)
    expect(await resolver.getMode(WS)).toBe('none')
  })
})
