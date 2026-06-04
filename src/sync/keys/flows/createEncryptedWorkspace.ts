/**
 * §8.1 — create an encrypted workspace (the key-minting flow).
 *
 * The one flow that brings an E2EE workspace into existence: it generates the
 * workspace key (WK), mints the canary the server stores, creates the server
 * row, and — only after the server row exists — persists the WK on this device
 * and pins the workspace `e2ee` (§6 rule 1). It returns the `kmp-wk-1:` string
 * to show the user ONCE; no WK bytes are ever sent to the server (only the
 * canary, which is opaque ciphertext).
 *
 * Decoupled from the data layer by construction: the workspace-create RPC is
 * INJECTED (`deps.createWorkspace`) and the flow only owns crypto + key store +
 * pin. It passes the RPC's result straight through (spread onto the return), so
 * it never needs to know the workspace row's shape — the UI gets
 * `CreatedWorkspace & { workspaceKey }`.
 */

import { validateCanary, mintCanary } from '../../crypto/canary.js'
import {
  formatWorkspaceKey,
  generateWorkspaceKeyBytes,
  importWorkspaceKey,
} from '../../crypto/workspaceKey.js'
import type { WorkspaceKeyStore } from '../keyStore.js'
import { setModePin } from '../modePin.js'

export interface CreateEncryptedWorkspaceDeps<T> {
  /** The signed-in user — keys and pins are per (user, workspace). */
  readonly userId: string
  /** Where the imported non-extractable WK is stored on this device (§5). */
  readonly keyStore: WorkspaceKeyStore
  /** Injected workspace-create RPC. Must send the e2ee params to the server
   *  and return whatever the caller wants passed back (e.g. CreatedWorkspace). */
  readonly createWorkspace: (
    name: string,
    options: { encryptionMode: 'e2ee'; workspaceId: string; wkCanary: string },
  ) => Promise<T>
  /** Injectable for deterministic tests; defaults to a v4 UUID. */
  readonly newWorkspaceId?: () => string
  /** Injectable for deterministic tests; defaults to the CSPRNG. */
  readonly generateKeyBytes?: () => Uint8Array<ArrayBuffer>
}

export const createEncryptedWorkspace = async <T extends object>(
  name: string,
  deps: CreateEncryptedWorkspaceDeps<T>,
): Promise<T & { workspaceKey: string }> => {
  const workspaceId = (deps.newWorkspaceId ?? (() => crypto.randomUUID()))()
  const keyBytes = (deps.generateKeyBytes ?? generateWorkspaceKeyBytes)()
  // The paste-friendly string is the ONLY place the raw key ever leaves this
  // function; show it once, then it lives only as a non-extractable handle.
  const workspaceKey = formatWorkspaceKey(keyBytes)
  const cryptoKey = await importWorkspaceKey(keyBytes)
  keyBytes.fill(0) // drop the raw bytes once imported (the handle is enough)

  const wkCanary = await mintCanary(cryptoKey, workspaceId)
  // Self-check (§8.1): the canary we're about to store must validate against
  // the key that minted it. A failure means a crypto/env bug — fail before
  // creating a server row whose canary no device could ever open.
  if (!(await validateCanary(cryptoKey, wkCanary, workspaceId))) {
    throw new Error('createEncryptedWorkspace: freshly minted canary failed self-validation')
  }

  // Server row first: if the RPC throws, we've written no local key or pin for
  // a workspace that doesn't exist.
  const created = await deps.createWorkspace(name, {
    encryptionMode: 'e2ee',
    workspaceId,
    wkCanary,
  })

  await deps.keyStore.put(deps.userId, workspaceId, cryptoKey)
  setModePin(deps.userId, workspaceId, 'e2ee')

  return { ...created, workspaceKey }
}
