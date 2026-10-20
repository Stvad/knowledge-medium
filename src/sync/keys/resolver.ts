/**
 * Sync-mode resolver (design doc §6 + §9.2).
 *
 * The single place that turns the durable per-(user, workspace) mode pin (§6)
 * plus the per-device workspace-key store (§5) into the three decisions the
 * Layout B sync seam needs:
 *
 *   - getMaterializability(ws) — observer: how to turn a `blocks_synced` row
 *     into the app-visible plaintext `blocks` table (decrypt / copy / defer).
 *   - getCek(ws)               — observer + upload: the workspace CryptoKey,
 *     read through `requireWorkspaceKeys`, which throws (and reports the
 *     workspace locked) when this device holds no usable key.
 *   - getUploadMode(ws)        — upload: seal content columns on the way out
 *     ('e2ee'), pass them through ('none'), or keep them queued ('hold').
 *
 * The PIN is the authority (§6 rule 1): the server's `encryption_mode` and the
 * `enc:v1:` prefix are both untrusted. The server's mode is read in ONE
 * direction only — it can make this device stricter, never looser
 * (docs/workspace-e2ee-conversion.md §6.2): a server that says e2ee while the
 * pin is not e2ee makes the device DEFER materialization and HOLD uploads until
 * the pin is upgraded, and nothing the server says can make an e2ee pin decrypt
 * less. A false e2ee claim therefore only stalls a device.
 * First-encounter handling (the server-trusting branches a/b of §6 rule 3) lives
 * in the §8 flows that own the UI to prompt/quarantine; it surfaces here only as
 * the fail-safe default — an UNPINNED workspace is never materialized (defer)
 * and never encrypted as e2ee on upload until a flow pins it.
 *
 * Materializability policy (the §6 collapse at the data layer):
 *   pin 'e2ee'  & WK loaded              → 'decrypt'
 *   pin 'e2ee'  & WK absent               → 'defer'  (locked read-only — §6 rule 3)
 *   pin 'plaintext' & server says e2ee   → 'defer'  (converted in place, not yet upgraded)
 *   pin 'plaintext' otherwise            → 'copy'   (no key; copy the row through)
 *   unpinned (null)                      → 'defer'  (first-encounter quarantine — §6 rule 3)
 *
 * Upload-mode policy:
 *   pin 'e2ee'                           → 'e2ee'   (seal content columns on the wire)
 *   otherwise, server says e2ee          → 'hold'   (never send plaintext to it)
 *   otherwise                            → 'none'   (plaintext / unpinned — pass through)
 *
 * "Server says e2ee" is the SYNCED `workspaces.encryption_mode`, which rides the
 * same checkpoint as the blocks it governs, so a row is never staged ahead of
 * the mode that covers it. A missing row does not count as e2ee, since a device
 * with no row has no synced blocks for it (and the entry gate waits for it). An
 * unreadable mode holds uploads, and makes materialization throw so the window
 * is retried.
 *
 * Bound to a `getUserId` thunk rather than a fixed id so the resolver reads the
 * current user fresh: a signed-out resolver (`null`) fails safe — defer, no key,
 * mode 'none' — instead of resolving against a stale id.
 */

import type { GetCek, GetMaterializability, UploadMode } from '../transform.js'
import type { WorkspaceKeyStore } from './keyStore.js'
import { getModePin, type ModePin } from './modePin.js'
import { requireWorkspaceKeys, WorkspaceKeyUnavailableError } from './openWorkspaceKeys.js'

export interface SyncResolver {
  /** Observer: how to materialize a workspace's staging rows. */
  readonly getMaterializability: GetMaterializability
  /** Observer + upload: the workspace key handle. Null only signed out; a
   *  missing key throws `WorkspaceKeyUnavailableError`. */
  readonly getCek: GetCek
  /** Asset read/write path (§10): the workspace's content-key HMAC subkey
   *  `K_id`, under the same contract as {@link getCek}. */
  readonly getContentKeyHmac: (workspaceId: string) => Promise<CryptoKey | null>
  /** Upload: seal, pass through, or hold the workspace's content columns. */
  readonly getUploadMode: (workspaceId: string) => Promise<UploadMode>
}

/** The synced `workspaces.encryption_mode` for a workspace, or null when this
 *  device has no local row for it. */
export type ReadSyncedEncryptionMode = (workspaceId: string) => Promise<string | null>

/** The upload-mode policy (module header) for one pin, reading the synced
 *  `encryption_mode` only when the pin leaves the answer open. Throws when that
 *  read does. Also decides the alias-seat namespace (`@/data/aliasSeatNamespace`),
 *  which may be public only when the rows it names leave as plaintext. */
export const uploadModeFor = async (
  pin: ModePin | null,
  readSyncedEncryptionMode: () => Promise<string | null>,
): Promise<UploadMode> => {
  if (pin === 'e2ee') return 'e2ee'
  return (await readSyncedEncryptionMode()) === 'e2ee' ? 'hold' : 'none'
}

export const createSyncResolver = (
  getUserId: () => string | null,
  keyStore: WorkspaceKeyStore,
  readSyncedEncryptionMode: ReadSyncedEncryptionMode,
): SyncResolver => {
  const serverSaysE2ee = async (workspaceId: string): Promise<boolean> =>
    (await readSyncedEncryptionMode(workspaceId)) === 'e2ee'

  const getCek: GetCek = async (workspaceId) => {
    const userId = getUserId()
    if (!userId) return null
    return (await requireWorkspaceKeys(keyStore, userId, workspaceId)).cek
  }

  const getContentKeyHmac = async (workspaceId: string): Promise<CryptoKey | null> => {
    const userId = getUserId()
    if (!userId) return null
    return (await requireWorkspaceKeys(keyStore, userId, workspaceId)).contentKeyHmac
  }

  const getMaterializability: GetMaterializability = async (workspaceId) => {
    const userId = getUserId()
    if (!userId) return 'defer'
    const pin = getModePin(userId, workspaceId)
    // An unreadable mode THROWS here, unlike an unreadable key below: a throw
    // leaves the observer's window queued for a retry, while a `defer` would
    // consume it and strand a plaintext row nothing else re-reads.
    if (pin === 'plaintext') return (await serverSaysE2ee(workspaceId)) ? 'defer' : 'copy'
    if (pin === 'e2ee') {
      // No key defers: the row stays staged until the gate's unlock drains it.
      // Thrown, it would abort the whole observer drain, every workspace's rows
      // with it, since this runs outside the per-row decode try/catch.
      try {
        await getCek(workspaceId)
        return 'decrypt'
      } catch (err) {
        if (err instanceof WorkspaceKeyUnavailableError) return 'defer'
        throw err
      }
    }
    // Unpinned: never materialize until a §8 flow resolves the first encounter.
    return 'defer'
  }

  const getUploadMode = async (workspaceId: string): Promise<UploadMode> => {
    const userId = getUserId()
    if (!userId) return 'none'
    // Synced, not live: a write queued before this device saw the flip goes out
    // plaintext, the ciphertext trigger refuses it, and it is quarantined until
    // Retry after the upgrade (docs/workspace-e2ee-conversion.md §3). Holding it
    // instead would block the checkpoint that tells the device about the flip.
    try {
      return await uploadModeFor(
        getModePin(userId, workspaceId), () => readSyncedEncryptionMode(workspaceId))
    } catch (err) {
      // A held write is retried with the queue, so holding loses nothing.
      console.warn(`[syncResolver] encryption_mode read failed for ${workspaceId}; holding uploads`, err)
      return 'hold'
    }
  }

  return { getMaterializability, getCek, getContentKeyHmac, getUploadMode }
}
