/**
 * Workspace key-check canary (§7/§8).
 *
 * The canary is an AEAD-sealed known plaintext — the workspace id —
 * stored in `workspaces.wk_canary`. Decrypting it with a candidate WK
 * both authenticates the key (AEAD failure = wrong key) and confirms it
 * is bound to THIS workspace (right key on another workspace's canary
 * fails the plaintext-equals-id check). It validates a pasted WK even on
 * a workspace that has no blocks yet (freshly invited or just created).
 */

import { canaryAad } from './aad.js'
import { open, seal } from './aead.js'

/** Mint the canary for a new E2EE workspace (§8.1). */
export const mintCanary = (key: CryptoKey, workspaceId: string): Promise<string> =>
  seal(key, workspaceId, canaryAad(workspaceId))

/** Validate a candidate WK against a workspace's stored canary (§8.2).
 *  Returns false on AEAD failure (wrong key) or plaintext mismatch
 *  (right key, wrong workspace) — never throws for a bad key. */
export const validateCanary = async (
  key: CryptoKey,
  canary: string,
  workspaceId: string,
): Promise<boolean> => {
  try {
    const plaintext = await open(key, canary, canaryAad(workspaceId))
    return plaintext === workspaceId
  } catch {
    return false
  }
}
