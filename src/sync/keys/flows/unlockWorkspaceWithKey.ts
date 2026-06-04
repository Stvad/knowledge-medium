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
 *   - re-unlocking a workspace already pinned `e2ee` whose WK was dropped by a
 *     §6 Lock & wipe (the pin survives; re-pinning the same value is a no-op).
 *
 * Pure of UI and DB: the canary comes in as a string and the key store is
 * injected. The caller (Phase E UI) supplies `workspaces.wk_canary` and, on
 * success, re-materializes the workspace via the observer's `drainWorkspace`.
 */

import { validateCanary } from '../../crypto/canary.js'
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
   *  `invalid-key`: well-formed, but doesn't decrypt THIS workspace's canary. */
  | { readonly ok: false; readonly reason: 'format' | 'invalid-key' }

export const unlockWorkspaceWithKey = async (
  args: UnlockWorkspaceArgs,
): Promise<UnlockWorkspaceResult> => {
  const { userId, workspaceId, canary, pastedKey, keyStore } = args

  let key: CryptoKey
  try {
    key = await importWorkspaceKey(parseWorkspaceKey(pastedKey))
  } catch {
    return { ok: false, reason: 'format' }
  }

  if (!(await validateCanary(key, canary, workspaceId))) {
    return { ok: false, reason: 'invalid-key' }
  }

  // Validated: persist the WK and pin e2ee. Re-pinning an already-e2ee
  // workspace (post-wipe re-paste) is a no-op; the pin is never downgraded.
  await keyStore.put(userId, workspaceId, key)
  setModePin(userId, workspaceId, 'e2ee')
  return { ok: true }
}
