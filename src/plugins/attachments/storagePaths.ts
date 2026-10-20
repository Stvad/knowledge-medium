/*
 * Single source of truth for WHERE an attachment object lives in Supabase Storage
 * and HOW to address it (design §10). Every remote address derives from here so they
 * can't drift apart (capture derives only the local byte-store name and block id):
 *   - {@link deriveObjectKey}: the object's key, derived when it's used;
 *   - the up-lane / resolver go through storage-js (`from(bucket).upload/download`),
 *     which builds the object path internally — they pass it attachmentObjectPath;
 *   - the off-path ciphertext audit needs a Range header storage-js doesn't expose,
 *     and a single-object delete has no storage-js call, so both hand-build the
 *     request URL via storageObjectUrl — kept HERE,
 *     matching storage-js's own shape, so a future storage-js bump can't silently
 *     leave the audit hitting a different (404-ing) endpoint than the app's reads.
 */

import { deriveContentKey } from '@/sync/crypto/contentKey.js'
import { WorkspaceKeyUnavailableError } from '@/sync/keys/openWorkspaceKeys.js'
import type { SyncMode } from '@/sync/transform.js'

export type ObjectKeyDerivation =
  | {
      readonly ok: true
      /** The Storage key under `<workspaceId>/`. */
      readonly objectKey: string
      /** The byte-store names this device may hold the plaintext under, in lookup
       *  order: the object key and, for an e2ee workspace, the raw name too. */
      readonly localKeys: readonly string[]
    }
  | {readonly ok: false; readonly reason: 'no-content-key' | 'invalid-hash'}

/**
 * An attachment's Storage key, derived from its content hash and the workspace's
 * mode AT USE TIME — never read from what a queue record stored at capture
 * (docs/workspace-e2ee-conversion.md §6.2). A record captured before an in-place
 * conversion has a raw key; once the workspace is e2ee, its object belongs at the
 * keyed one, and deriving it here sends it there with no re-keying. The record's
 * own `contentKey` stays what it always was: the byte-store name its bytes were
 * written under.
 *
 * The raw name stays a LOCAL name after the conversion, so bytes captured or
 * downloaded before it keep serving without a download. Only this device writes
 * its byte store, and every write is hash-verified, so the raw-named entry is
 * the same plaintext. It is never fetched remotely: the server's raw object is
 * the one the conversion deletes.
 *
 * E2EE needs `K_id`; without it — its read threw `WorkspaceKeyUnavailableError`,
 * which also locked the workspace — the derivation fails closed, as does a
 * malformed hash.
 */
export const deriveObjectKey = async (
  contentHash: string,
  mode: SyncMode,
  getContentKeyHmac: () => Promise<CryptoKey | null>,
): Promise<ObjectKeyDerivation> => {
  const contentKeyHmac = mode === 'e2ee'
    ? await getContentKeyHmac().catch(err => {
        if (err instanceof WorkspaceKeyUnavailableError) return null
        throw err
      })
    : null
  if (mode === 'e2ee' && !contentKeyHmac) return {ok: false, reason: 'no-content-key'}
  try {
    const objectKey = await deriveContentKey({contentHash, mode, contentKeyHmac})
    if (mode === 'none') return {ok: true, objectKey, localKeys: [objectKey]}
    const rawKey = await deriveContentKey({contentHash, mode: 'none', contentKeyHmac: null})
    return {ok: true, objectKey, localKeys: [objectKey, rawKey]}
  } catch {
    return {ok: false, reason: 'invalid-hash'}
  }
}

/** The flat object path within the attachments bucket: `<workspaceId>/<contentKey>`
 *  (§10 — the layout the RLS policies enforce; never nested). */
export const attachmentObjectPath = (workspaceId: string, contentKey: string): string =>
  `${workspaceId}/${contentKey}`

/**
 * The authenticated Storage object URL for a Range GET, built to MATCH storage-js's
 * own `download()` shape: `${url}/object/${bucket}/${path}` (StorageFileApi resolves
 * `_getFinalPath(path) = ${bucketId}/${path}` and prefixes `${url}/object/`). Each
 * path segment is percent-encoded. There is deliberately NO `/authenticated/` segment
 * — that would address a bucket literally named "authenticated" and 404 every object.
 */
export const authenticatedObjectUrl = (baseUrl: string, bucket: string, path: string): string =>
  storageObjectUrl(`${baseUrl.replace(/\/$/, '')}/storage/v1`, bucket, path)

/** One object's URL under a Storage API base (`<project>/storage/v1`), each
 *  path segment percent-encoded: storage-js's own `/object/<bucket>/<path>`. */
export const storageObjectUrl = (storageUrl: string, bucket: string, path: string): string =>
  `${storageUrl}/object/${bucket}/${path.split('/').map(encodeURIComponent).join('/')}`
