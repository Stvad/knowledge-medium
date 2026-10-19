/**
 * Minting a workspace key (WK): the half that creating an encrypted workspace
 * (§8.1) and converting a plaintext one in place
 * (docs/workspace-e2ee-conversion.md §6.3 step 1) share. Neither flow trusts a
 * key it can't prove recoverable, so the string shown to the user is re-parsed
 * and must open the canary before anything is stored or sent.
 */

import { mintCanary, validateCanary } from '../crypto/canary.js'
import { deriveContentKeyHmac } from '../crypto/contentKey.js'
import {
  formatWorkspaceKey,
  generateWorkspaceKeyBytes,
  importWorkspaceKey,
  parseWorkspaceKey,
} from '../crypto/workspaceKey.js'
import type { WorkspaceKeyRecord, WorkspaceKeyStore } from './keyStore.js'

export interface MintedWorkspaceKey {
  /** What the key store holds: the non-extractable WK and its K_id. */
  readonly record: WorkspaceKeyRecord & {readonly contentKeyHmac: CryptoKey}
  /** The `kmp-wk-1:` string, the only form the raw key ever leaves in. */
  readonly displayed: string
  /** The canary for `workspaceId` under this key. */
  readonly canary: string
}

export const mintWorkspaceKey = async (
  workspaceId: string,
  generateKeyBytes: () => Uint8Array<ArrayBuffer> = generateWorkspaceKeyBytes,
): Promise<MintedWorkspaceKey> => {
  const keyBytes = generateKeyBytes()
  const displayed = formatWorkspaceKey(keyBytes)
  let wk: CryptoKey
  let contentKeyHmac: CryptoKey
  try {
    wk = await importWorkspaceKey(keyBytes)
    // K_id needs the raw bytes, which the non-extractable WK can't give back.
    contentKeyHmac = await deriveContentKeyHmac(keyBytes)
  } finally {
    keyBytes.fill(0)
  }

  const canary = await mintCanary(wk, workspaceId)
  // Re-derived from the displayed string, not from `wk`: this proves the string
  // the user saves unlocks the workspace, not merely that this key does.
  const verifyBytes = parseWorkspaceKey(displayed)
  let verifyKey: CryptoKey
  try {
    verifyKey = await importWorkspaceKey(verifyBytes)
  } finally {
    verifyBytes.fill(0)
  }
  if (!(await validateCanary(verifyKey, canary, workspaceId))) {
    throw new Error('mintWorkspaceKey: the minted canary failed its round-trip check')
  }
  return {record: {wk, contentKeyHmac}, displayed, canary}
}

/** Never a real workspace id: written, then deleted. */
const KEY_STORE_PROBE_ID = '__e2ee_keystore_probe__'

/** Throws unless the key store takes a write and a delete of `record` now, so a
 *  flow refuses before it creates server state this device couldn't then open. */
export const probeKeyStore = async (
  keyStore: WorkspaceKeyStore,
  userId: string,
  record: WorkspaceKeyRecord,
): Promise<void> => {
  await keyStore.put(userId, KEY_STORE_PROBE_ID, record)
  await keyStore.delete(userId, KEY_STORE_PROBE_ID)
}
