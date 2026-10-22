// @vitest-environment node
/**
 * Which namespace an alias seat's id is derived under (#719).
 *
 * Node, with a stubbed localStorage, because an `e2ee` mode pin is only
 * writable against a durable store and the workspace needs `K_id` in the key
 * store — process-wide state a plaintext file must not inherit.
 *
 * The derived namespace is cached per (user, workspace) for the life of the
 * module, so every test takes a FRESH workspace id: reusing one would hand a
 * later test the namespace an earlier one cached.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import {
  seedWorkspaceRow as seedWorkspaceRowIn, storeWorkspaceKey, stubLocalStorage,
} from '@/data/test/e2eeFixtures'
import { deriveContentKeyHmac } from '@/sync/crypto/contentKey'
import { deriveWorkspaceIdNamespace } from '@/sync/crypto/derivedIdNamespace'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import { WorkspaceKeyUnavailableError } from '@/sync/keys/openWorkspaceKeys'
import { PLAINTEXT_ALIAS_SEATS } from '@/data/test/plaintextAliasSeats'
import { aliasSeatNamespacesInTx, resolveAliasSeatNamespaces } from './aliasSeatNamespace'

const USER = 'user-alias-ns'
/** Spelled out, because the central assertions are that a sealed workspace's
 *  ids are NOT minted under it. */
const PUBLIC_NS = 'a3c8a8c0-7c3a-4d2c-bc4f-1f6c2c6a7d11'

let sharedDb: TestDb
let repo: Repo
let workspaceCounter = 0
let WS = ''

const seedWorkspaceRow = (encryptionMode: 'none' | 'e2ee') =>
  seedWorkspaceRowIn(sharedDb.db, WS, USER, encryptionMode)
const storeContentKey = (fill = 7) => storeWorkspaceKey(USER, WS, fill)

const derivedFor = async (fill = 7) => deriveWorkspaceIdNamespace(
  await deriveContentKeyHmac(new Uint8Array(32).fill(fill)), 'km/alias-seat-ns/v1')

const inTx = async () => {
  let result: Awaited<ReturnType<typeof aliasSeatNamespacesInTx>> | undefined
  await repo.tx(async tx => {
    result = await aliasSeatNamespacesInTx(tx, repo, WS)
  }, {scope: ChangeScope.BlockDefault, description: 'probe'})
  return result!
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  await getWorkspaceKeyStore().delete(USER, WS)
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  stubLocalStorage()
  WS = `ws-alias-ns-${++workspaceCounter}`
  repo = createTestRepo({db: sharedDb.db, user: {id: USER}}).repo
  repo.setActiveWorkspaceId(WS)
})

describe('resolveAliasSeatNamespaces', () => {
  it('keeps the public namespace on a plaintext workspace', async () => {
    await seedWorkspaceRow('none')
    setModePin(USER, WS, 'plaintext')

    // Also what every plaintext suite's `PLAINTEXT_ALIAS_SEATS` spells out.
    const seats = await resolveAliasSeatNamespaces(repo, WS)
    expect(seats).toEqual(PLAINTEXT_ALIAS_SEATS)
    expect(seats.mint).toBe(PUBLIC_NS)
  })

  // Recomputed from the key bytes and the label spelled out here, not taken
  // from the code under test — otherwise a changed label or MAC slice would
  // stay green while every device minted somewhere else.
  it('mints an e2ee workspace\'s seats under HMAC(K_id, the versioned label)', async () => {
    await seedWorkspaceRow('e2ee')
    setModePin(USER, WS, 'e2ee')
    await storeContentKey(7)

    const seats = await resolveAliasSeatNamespaces(repo, WS)
    expect(seats.mint).toBe(await derivedFor(7))
    expect(seats.mint).not.toBe(PUBLIC_NS)
  })

  it('still recognizes seats an e2ee workspace minted under the public namespace', async () => {
    await seedWorkspaceRow('e2ee')
    setModePin(USER, WS, 'e2ee')
    await storeContentKey()

    expect((await resolveAliasSeatNamespaces(repo, WS)).recognized)
      .toEqual([await derivedFor(), PUBLIC_NS])
  })

  it('keeps an e2ee pin sealed when the synced row claims plaintext', async () => {
    // The pin is the authority; the server's column can only make this stricter.
    await seedWorkspaceRow('none')
    setModePin(USER, WS, 'e2ee')
    await storeContentKey()

    expect((await resolveAliasSeatNamespaces(repo, WS)).mint).toBe(await derivedFor())
  })

  it('refuses, rather than falling back to the public namespace, without K_id', async () => {
    await seedWorkspaceRow('e2ee')
    setModePin(USER, WS, 'e2ee')

    await expect(resolveAliasSeatNamespaces(repo, WS)).rejects.toBeInstanceOf(WorkspaceKeyUnavailableError)
  })

  it('treats a workspace the server converted as sealed before this device upgrades its pin',
    async () => {
      // Uploads are HELD in this window, so a public id minted now would leave
      // sealed later, naming its page.
      await seedWorkspaceRow('e2ee')
      setModePin(USER, WS, 'plaintext')

      await expect(resolveAliasSeatNamespaces(repo, WS)).rejects.toBeInstanceOf(WorkspaceKeyUnavailableError)
      await storeContentKey()
      expect((await resolveAliasSeatNamespaces(repo, WS)).mint).toBe(await derivedFor())
    })

  it('follows an in-place conversion while the app runs — the plaintext answer is not cached',
    async () => {
      await seedWorkspaceRow('none')
      setModePin(USER, WS, 'plaintext')
      expect((await resolveAliasSeatNamespaces(repo, WS)).mint).toBe(PUBLIC_NS)

      await seedWorkspaceRow('e2ee')
      await storeContentKey()
      expect((await resolveAliasSeatNamespaces(repo, WS)).mint).toBe(await derivedFor())
    })
})

describe('aliasSeatNamespacesInTx', () => {
  it('answers a plaintext workspace without any pre-lock resolve', async () => {
    await seedWorkspaceRow('none')
    setModePin(USER, WS, 'plaintext')

    expect(await inTx()).toEqual(PLAINTEXT_ALIAS_SEATS)
  })

  it('refuses a sealed workspace nothing resolved before the lock, even with K_id stored', async () => {
    // K_id is in IndexedDB, which this path must not open under the write lock.
    await seedWorkspaceRow('e2ee')
    setModePin(USER, WS, 'e2ee')
    await storeContentKey()

    await expect(inTx()).rejects.toThrow(/before the write lock/)
  })

  it('serves the namespace a pre-lock resolve cached', async () => {
    await seedWorkspaceRow('e2ee')
    setModePin(USER, WS, 'e2ee')
    await storeContentKey()
    await resolveAliasSeatNamespaces(repo, WS)

    expect((await inTx()).mint).toBe(await derivedFor())
  })

  it('re-reads the mode under the lock, so a flip after a plaintext resolve is not missed',
    async () => {
      await seedWorkspaceRow('none')
      setModePin(USER, WS, 'plaintext')
      await storeContentKey()
      expect((await resolveAliasSeatNamespaces(repo, WS)).mint).toBe(PUBLIC_NS)

      await seedWorkspaceRow('e2ee')

      await expect(inTx()).rejects.toThrow(/before the write lock/)
    })
})
