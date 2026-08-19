/**
 * §8.2 — open an E2EE workspace with a pasted workspace key (WK).
 *
 * The flow that turns a pasted `kmp-wk-1:` string into a usable, pinned
 * workspace on this device. It validates the candidate WK against the
 * workspace's stored `wk_canary` (AEAD failure = wrong key; plaintext mismatch =
 * right key, wrong workspace — both reject), and only on success imports the WK
 * into the key store and pins the workspace `e2ee` (§6 rule 1).
 *
 * Covers two entry points with one path:
 *   - first encounter on a new device / accepted invite (the key-required
 *     branch (a), or the quarantine branch (b) where pasting a valid WK defeats
 *     a server downgrade lie — §6 rule 3);
 *   - re-unlocking a workspace already pinned `e2ee` whose WK is absent on this
 *     device (re-pinning the same value is a no-op).
 *
 * Pure of UI and DB: the canary comes in as a string and the key store is
 * injected. The caller (Phase E UI) supplies `workspaces.wk_canary` and, on
 * success, re-materializes the workspace via the observer's `drainWorkspace`.
 */

import { validateCanary } from '../../crypto/canary.js'
import { deriveContentKeyHmac } from '../../crypto/contentKey.js'
import { importWorkspaceKey, parseWorkspaceKey } from '../../crypto/workspaceKey.js'
import type { WorkspaceKeyStore } from '../keyStore.js'
import { setModePin } from '../modePin.js'

export interface UnlockWorkspaceArgs {
  readonly userId: string
  readonly workspaceId: string
  /** The workspace's stored `wk_canary` (opaque ciphertext). */
  readonly canary: string
  /** The user-pasted `kmp-wk-1:` string (whitespace/case tolerated). */
  readonly pastedKey: string
  readonly keyStore: WorkspaceKeyStore
}

export type UnlockWorkspaceResult =
  | { readonly ok: true }
  /** `format`: the paste isn't a `kmp-wk-1:` key at all (typo / wrong text).
   *  `invalid-key`: well-formed, but doesn't decrypt THIS workspace's canary.
   *  `storage`: valid key, but this device couldn't persist it (IndexedDB
   *  quota / private mode) — retryable; the workspace is pinned e2ee + locked. */
  | { readonly ok: false; readonly reason: 'format' | 'invalid-key' | 'storage' }

export const unlockWorkspaceWithKey = async (
  args: UnlockWorkspaceArgs,
): Promise<UnlockWorkspaceResult> => {
  const { userId, workspaceId, canary, pastedKey, keyStore } = args

  let key: CryptoKey
  let contentKeyHmac: CryptoKey
  try {
    const wkBytes = parseWorkspaceKey(pastedKey)
    try {
      key = await importWorkspaceKey(wkBytes)
      // Derive K_id (§10) from the raw bytes in their ONLY in-scope window — the
      // stored WK handle is non-extractable, so this is the one chance.
      contentKeyHmac = await deriveContentKeyHmac(wkBytes)
    } finally {
      // Zero on EVERY exit (success or a throw mid-import/derive) — unlock
      // previously let the parsed bytes drop to GC un-zeroed; this closes that leak.
      wkBytes.fill(0)
    }
  } catch {
    return { ok: false, reason: 'format' }
  }

  if (!(await validateCanary(key, canary, workspaceId))) {
    return { ok: false, reason: 'invalid-key' }
  }

  // Canary validated → this workspace is genuinely e2ee. Pin it FIRST (in the
  // quarantine case the pin is what defeats a server downgrade lie), then
  // persist the key. Either write can fail if storage is blocked/full (private
  // mode, IndexedDB quota, localStorage disabled); both surface as a retryable
  // 'storage' result rather than throwing out of the flow, so the caller can
  // reset and report. Re-pinning an already-e2ee workspace is a no-op.
  try {
    setModePin(userId, workspaceId, 'e2ee')
    await keyStore.put(userId, workspaceId, { wk: key, contentKeyHmac })
  } catch (err) {
    console.warn(`unlockWorkspaceWithKey: persisting unlock failed for ${workspaceId}`, err)
    return { ok: false, reason: 'storage' }
  }
  return { ok: true }
}
