/**
 * Sync-mode resolver (design doc §6 + §9.2).
 *
 * The single place that turns the durable per-(user, workspace) mode pin (§6)
 * plus the per-device workspace-key store (§5) into the three decisions the
 * Layout B sync seam needs:
 *
 *   - getMaterializability(ws) — observer: how to turn a `blocks_synced` row
 *     into the app-visible plaintext `blocks` table (decrypt / copy / defer).
 *   - getCek(ws)               — observer + upload: the workspace CryptoKey, or
 *     null if it isn't loaded on this device.
 *   - getMode(ws)              — upload: whether to seal content columns on the
 *     way out ('e2ee') or pass them through ('none').
 *
 * The PIN is the authority (§6 rule 1): the server's `encryption_mode` and the
 * `enc:v1:` prefix are both untrusted, so this module reads ONLY the local pin
 * and the local key store, never the server flag. First-encounter handling (the
 * server-trusting branches a/b of §6 rule 3) lives in the §8 flows that own the
 * UI to prompt/quarantine; it surfaces here only as the fail-safe default — an
 * UNPINNED workspace is never materialized (defer) and never encrypted as e2ee
 * on upload until a flow pins it.
 *
 * Materializability policy (the §6 collapse at the data layer):
 *   pin 'plaintext'          → 'copy'    (no key; copy the row through)
 *   pin 'e2ee'  & WK loaded   → 'decrypt'
 *   pin 'e2ee'  & WK absent    → 'defer'  (locked read-only — §6 rule 3)
 *   unpinned (null)          → 'defer'  (first-encounter quarantine — §6 rule 3)
 *
 * Upload-mode policy:
 *   pin 'e2ee'               → 'e2ee'   (seal content columns on the wire)
 *   otherwise                → 'none'   (plaintext / unpinned — pass through)
 *
 * Bound to a `getUserId` thunk rather than a fixed id so the resolver reads the
 * current user fresh: a signed-out resolver (`null`) fails safe — defer, no key,
 * mode 'none' — instead of resolving against a stale id.
 */

import type { GetCek, GetMaterializability, SyncMode } from '../transform.js'
import type { WorkspaceKeyStore } from './keyStore.js'
import { getModePin } from './modePin.js'

export interface SyncResolver {
  /** Observer: how to materialize a workspace's staging rows. */
  readonly getMaterializability: GetMaterializability
  /** Observer + upload: the workspace key handle, or null if not loaded. */
  readonly getCek: GetCek
  /** Asset read/write path (§10): the workspace's content-key HMAC subkey
   *  `K_id`, or null when no key is loaded OR a legacy record predates K_id
   *  (the §10 re-paste migration — media fails closed until re-unlock). */
  readonly getContentKeyHmac: (workspaceId: string) => Promise<CryptoKey | null>
  /** Upload: whether to encrypt content columns on the wire. */
  readonly getMode: (workspaceId: string) => Promise<SyncMode>
}

export const createSyncResolver = (
  getUserId: () => string | null,
  keyStore: WorkspaceKeyStore,
): SyncResolver => {
  const getCek: GetCek = async (workspaceId) => {
    const userId = getUserId()
    if (!userId) return null
    try {
      return (await keyStore.get(userId, workspaceId))?.wk ?? null
    } catch (err) {
      // A key-store read failure (IndexedDB unavailable / corrupt / quota) must
      // never throw out of the resolver: getMaterializability (below) runs
      // OUTSIDE materializeStagingRows' per-row decode try/catch, so a throw
      // there aborts the entire observer drain and strands the durable change
      // queue. Treat an unreadable store as "no key".
      console.warn(`[syncResolver] key read failed for ${workspaceId}; treating as no key`, err)
      return null
    }
  }

  const getContentKeyHmac = async (workspaceId: string): Promise<CryptoKey | null> => {
    const userId = getUserId()
    if (!userId) return null
    try {
      return (await keyStore.get(userId, workspaceId))?.contentKeyHmac ?? null
    } catch (err) {
      // Same fail-safe as getCek: an unreadable store yields no K_id, so the
      // asset resolver fails the media closed rather than throwing.
      console.warn(`[syncResolver] K_id read failed for ${workspaceId}; treating as absent`, err)
      return null
    }
  }

  const getMaterializability: GetMaterializability = async (workspaceId) => {
    const userId = getUserId()
    if (!userId) return 'defer'
    const pin = getModePin(userId, workspaceId)
    if (pin === 'plaintext') return 'copy'
    if (pin === 'e2ee') {
      // getCek swallows read failures → null, so an unreadable key store defers
      // (leaves the row staged; retries when the store recovers / WK is pasted)
      // instead of wedging the drain.
      const key = await getCek(workspaceId)
      return key ? 'decrypt' : 'defer'
    }
    // Unpinned: never materialize until a §8 flow resolves the first encounter.
    return 'defer'
  }

  const getMode = async (workspaceId: string): Promise<SyncMode> => {
    const userId = getUserId()
    if (!userId) return 'none'
    return getModePin(userId, workspaceId) === 'e2ee' ? 'e2ee' : 'none'
  }

  return { getMaterializability, getCek, getContentKeyHmac, getMode }
}
