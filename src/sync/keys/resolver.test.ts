// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryWorkspaceKeyStore } from './keyStore.js'
import { setModePin, upgradeModePinToE2ee } from './modePin.js'
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

// The synced `workspaces.encryption_mode` each test's server reports; absent
// means no local row.
let syncedMode: Map<string, string>
const readSyncedEncryptionMode = async (workspaceId: string) => syncedMode.get(workspaceId) ?? null
beforeEach(() => {
  syncedMode = new Map()
})

const build = (userId: string | null = USER) => {
  const keyStore = new InMemoryWorkspaceKeyStore()
  const resolver = createSyncResolver(() => userId, keyStore, readSyncedEncryptionMode)
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
    const resolver = createSyncResolver(() => USER, throwingStore, readSyncedEncryptionMode)
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
    const resolver = createSyncResolver(() => USER, keyStore, readSyncedEncryptionMode)
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
    const resolver = createSyncResolver(() => USER, throwingStore, readSyncedEncryptionMode)
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
    const resolver = createSyncResolver(() => USER, throwingStore, readSyncedEncryptionMode)
    await expect(resolver.getContentKeyHmac(WS)).resolves.toBeNull()
  })
})

describe('createSyncResolver — getUploadMode (encrypt-on-upload)', () => {
  it('e2ee pin → e2ee', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'e2ee')
    expect(await resolver.getUploadMode(WS)).toBe('e2ee')
  })

  it('plaintext pin → none', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'plaintext')
    expect(await resolver.getUploadMode(WS)).toBe('none')
  })

  it('unpinned → none (never encrypts an unpinned workspace)', async () => {
    const { resolver } = build()
    expect(await resolver.getUploadMode(WS)).toBe('none')
  })

  it('signed-out → none', async () => {
    const { resolver } = build(null)
    expect(await resolver.getUploadMode(WS)).toBe('none')
  })
})

// Conversion in place (docs/workspace-e2ee-conversion.md §6.2): the server can
// say e2ee while this device's pin still says plaintext. The server's mode may
// make the device defer or hold — never decrypt less, never send plaintext.
describe('createSyncResolver — pin plaintext while the server says e2ee', () => {
  it('materialization defers, so local blocks keep their plaintext', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'plaintext')
    syncedMode.set(WS, 'e2ee')
    expect(await resolver.getMaterializability(WS)).toBe('defer')
  })

  it('defers even when this device already holds the workspace key (the converting device)', async () => {
    const { resolver, keyStore } = build()
    setModePin(USER, WS, 'plaintext')
    await keyStore.put(USER, WS, record(FAKE_KEY, FAKE_HMAC))
    syncedMode.set(WS, 'e2ee')
    expect(await resolver.getMaterializability(WS)).toBe('defer')
    expect(await resolver.getUploadMode(WS)).toBe('hold')
  })

  it('uploads are held rather than sent plaintext', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'plaintext')
    syncedMode.set(WS, 'e2ee')
    expect(await resolver.getUploadMode(WS)).toBe('hold')
  })

  it('an unpinned workspace the server calls e2ee holds too', async () => {
    const { resolver } = build()
    syncedMode.set(WS, 'e2ee')
    expect(await resolver.getUploadMode(WS)).toBe('hold')
  })

  it('a server that says none leaves a plaintext pin copying and uploading plaintext', async () => {
    const { resolver } = build()
    setModePin(USER, WS, 'plaintext')
    syncedMode.set(WS, 'none')
    expect(await resolver.getMaterializability(WS)).toBe('copy')
    expect(await resolver.getUploadMode(WS)).toBe('none')
  })

  it('no local workspaces row leaves a plaintext pin as it was', async () => {
    // The row rides the same checkpoint as the blocks, so a device with no row
    // has no synced rows for that workspace to copy either.
    const { resolver } = build()
    setModePin(USER, WS, 'plaintext')
    expect(await resolver.getMaterializability(WS)).toBe('copy')
    expect(await resolver.getUploadMode(WS)).toBe('none')
  })

  it('an unreadable server mode never copies: materialization throws, so the window retries', async () => {
    // A `defer` would consume the observer's window and strand plaintext rows.
    setModePin(USER, WS, 'plaintext')
    const resolver = createSyncResolver(() => USER, new InMemoryWorkspaceKeyStore(), async () => {
      throw new Error('database is locked')
    })
    await expect(resolver.getMaterializability(WS)).rejects.toThrow('database is locked')
  })

  it('an unreadable server mode holds uploads', async () => {
    setModePin(USER, WS, 'plaintext')
    const resolver = createSyncResolver(() => USER, new InMemoryWorkspaceKeyStore(), async () => {
      throw new Error('database is locked')
    })
    await expect(resolver.getUploadMode(WS)).resolves.toBe('hold')
  })

  it('never makes an e2ee pin decrypt less: a server that says none still decrypts and seals', async () => {
    const { resolver, keyStore } = build()
    setModePin(USER, WS, 'e2ee')
    await keyStore.put(USER, WS, record(FAKE_KEY))
    syncedMode.set(WS, 'none')
    expect(await resolver.getMaterializability(WS)).toBe('decrypt')
    expect(await resolver.getUploadMode(WS)).toBe('e2ee')
  })

  it('after the pin upgrade the same workspace decrypts and seals', async () => {
    const { resolver, keyStore } = build()
    setModePin(USER, WS, 'plaintext')
    syncedMode.set(WS, 'e2ee')
    await keyStore.put(USER, WS, record(FAKE_KEY, FAKE_HMAC))
    upgradeModePinToE2ee(USER, WS)
    expect(await resolver.getMaterializability(WS)).toBe('decrypt')
    expect(await resolver.getUploadMode(WS)).toBe('e2ee')
  })
})
