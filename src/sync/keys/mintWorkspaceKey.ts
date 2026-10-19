/**
 * Minting a workspace key (WK): the half that creating an encrypted workspace
 * (§8.1) and converting a plaintext one in place
 * (docs/workspace-e2ee-conversion.md §6.3 step 1) share. Neither flow trusts a
 * key it can't prove recoverable, so the key is imported from the very string
 * shown to the user, and that string must open the canary before anything is
 * stored or sent.
 */

import { mintCanary, validateCanary } from '../crypto/canary.js'
import { formatWorkspaceKey, generateWorkspaceKeyBytes } from '../crypto/workspaceKey.js'
import { importPastedWorkspaceKey, type PastedWorkspaceKey } from './flows/pastedKey.js'
import type { WorkspaceKeyRecord, WorkspaceKeyStore } from './keyStore.js'

export interface MintedWorkspaceKey {
  /** What the key store holds: the non-extractable WK and its K_id. */
  readonly record: PastedWorkspaceKey
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
  keyBytes.fill(0)
  const record = await importPastedWorkspaceKey(displayed)
  if (!record) throw new Error('mintWorkspaceKey: the minted key does not parse back')
  const canary = await mintCanary(record.wk, workspaceId)
  // Defence in depth: guards a mint/validate pairing that has drifted apart,
  // before any server row exists whose canary no device could open.
  if (!(await validateCanary(record.wk, canary, workspaceId))) {
    throw new Error('mintWorkspaceKey: the minted canary failed its round-trip check')
  }
  return {record, displayed, canary}
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
