import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { InMemoryWorkspaceKeyStore } from '../keyStore.js'
import { getModePin, setModePin } from '../modePin.js'
import { mintCanary } from '../../crypto/canary.js'
import {
  formatWorkspaceKey,
  generateWorkspaceKeyBytes,
  importWorkspaceKey,
} from '../../crypto/workspaceKey.js'
import { unlockWorkspaceWithKey } from './unlockWorkspaceWithKey.js'

const USER = 'user-1'
const WS = 'ws-A'

beforeEach(() => localStorage.clear())
afterEach(() => localStorage.clear())

/** Mint a fresh WK + the canary a server would store for `workspaceId`. */
const mintKeyAndCanary = async (workspaceId: string) => {
  const bytes = generateWorkspaceKeyBytes()
  const key = await importWorkspaceKey(bytes)
  const canary = await mintCanary(key, workspaceId)
  return { wkString: formatWorkspaceKey(bytes), canary }
}

describe('unlockWorkspaceWithKey (§8.2)', () => {
  it('stores the key and pins e2ee when the pasted WK opens the canary', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    const { wkString, canary } = await mintKeyAndCanary(WS)

    const result = await unlockWorkspaceWithKey({
      userId: USER,
      workspaceId: WS,
      canary,
      pastedKey: wkString,
      keyStore,
    })

    expect(result.ok).toBe(true)
    expect(await keyStore.get(USER, WS)).not.toBeNull()
    expect(getModePin(USER, WS)).toBe('e2ee')
  })

  it('rejects a well-formed WK that does not open the canary — no key, no pin', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    const { canary } = await mintKeyAndCanary(WS)
    // A different, valid-format WK that never minted this canary.
    const { wkString: wrongKey } = await mintKeyAndCanary('ws-other')

    const result = await unlockWorkspaceWithKey({
      userId: USER,
      workspaceId: WS,
      canary,
      pastedKey: wrongKey,
      keyStore,
    })

    expect(result).toEqual({ ok: false, reason: 'invalid-key' })
    expect(await keyStore.get(USER, WS)).toBeNull()
    expect(getModePin(USER, WS)).toBeNull()
  })

  it('rejects a malformed paste (missing prefix) as a format error', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    const { canary } = await mintKeyAndCanary(WS)

    const result = await unlockWorkspaceWithKey({
      userId: USER,
      workspaceId: WS,
      canary,
      pastedKey: 'not-a-workspace-key',
      keyStore,
    })

    expect(result).toEqual({ ok: false, reason: 'format' })
    expect(await keyStore.get(USER, WS)).toBeNull()
    expect(getModePin(USER, WS)).toBeNull()
  })

  it('reports a storage failure (still pins e2ee to defeat a downgrade) when the key write throws', async () => {
    const { wkString, canary } = await mintKeyAndCanary(WS)
    // A valid key, but the device can't persist it (IndexedDB quota / private mode).
    const failingStore = {
      get: async () => null,
      put: async () => {
        throw new Error('QuotaExceededError')
      },
      delete: async () => {},
      clearForUser: async () => {},
    }

    const result = await unlockWorkspaceWithKey({
      userId: USER,
      workspaceId: WS,
      canary,
      pastedKey: wkString,
      keyStore: failingStore,
    })

    expect(result).toEqual({ ok: false, reason: 'storage' })
    // The canary validated, so the workspace IS e2ee — pin it even though the
    // key couldn't be stored, closing the quarantine plaintext-confirm hatch.
    expect(getModePin(USER, WS)).toBe('e2ee')
  })

  it('re-unlocks an already-e2ee-pinned workspace idempotently (post-wipe re-paste)', async () => {
    const keyStore = new InMemoryWorkspaceKeyStore()
    const { wkString, canary } = await mintKeyAndCanary(WS)
    setModePin(USER, WS, 'e2ee') // workspace pinned e2ee but its WK is absent on this device

    const result = await unlockWorkspaceWithKey({
      userId: USER,
      workspaceId: WS,
      canary,
      pastedKey: wkString,
      keyStore,
    })

    expect(result.ok).toBe(true)
    expect(await keyStore.get(USER, WS)).not.toBeNull()
    expect(getModePin(USER, WS)).toBe('e2ee')
  })
})
