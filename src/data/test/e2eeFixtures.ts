/**
 * Setup for tests of an END-TO-END ENCRYPTED workspace: a durable mode pin
 * needs a localStorage, and the workspace needs its key in the key store.
 */

import { vi } from 'vitest'
import { deriveContentKeyHmac } from '@/sync/crypto/contentKey'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import type { TestDb } from './createTestDb'

/** `setModePin` refuses to pin `e2ee` without a durable localStorage, the pin
 *  being the only local authority on the mode. Node has none, so this gives
 *  it one — fresh per call, so a pin never leaks across tests.
 *  `vi.unstubAllGlobals()` removes it. */
export const stubLocalStorage = (): void => {
  const entries = new Map<string, string>()
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, String(value)) },
    removeItem: (key: string) => { entries.delete(key) },
  }
  vi.stubGlobal('localStorage', storage)
  vi.stubGlobal('window', {localStorage: storage})
}

/** A workspace key where the unlock flows put it, with `K_id` derived from
 *  `fill`-repeated key bytes: two fills are two different workspace keys. */
export const storeWorkspaceKey = async (
  userId: string,
  workspaceId: string,
  fill = 7,
): Promise<void> => {
  const contentKeyHmac = await deriveContentKeyHmac(new Uint8Array(32).fill(fill))
  const wk = await crypto.subtle.generateKey(
    {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt'])
  await getWorkspaceKeyStore().put(userId, workspaceId, {wk, contentKeyHmac})
}

/** The local `workspaces` row, in `encryptionMode`, cell-backed. */
export const seedWorkspaceRow = async (
  db: TestDb['db'],
  workspaceId: string,
  ownerUserId: string,
  encryptionMode: 'none' | 'e2ee',
): Promise<void> => {
  await db.execute(
    `INSERT OR REPLACE INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary,
        properties_migration)
     VALUES (?, 'ws', ?, 1, 1, ?, NULL, 'cell')`,
    [workspaceId, ownerUserId, encryptionMode])
}
