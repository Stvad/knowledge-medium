/**
 * Single source of truth for WHERE an attachment object lives in Supabase Storage
 * and HOW to address it (design §10). Both consumers derive from here so they can't
 * drift apart:
 *   - the up-lane / resolver go through storage-js (`from(bucket).upload/download`),
 *     which builds the object path internally — they pass it {@link attachmentObjectPath};
 *   - the off-path ciphertext audit needs a Range header storage-js doesn't expose,
 *     so it hand-builds the request URL via {@link authenticatedObjectUrl} — kept HERE,
 *     matching storage-js's own shape, so a future storage-js bump can't silently
 *     leave the audit hitting a different (404-ing) endpoint than the app's reads.
 */

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
export const authenticatedObjectUrl = (baseUrl: string, bucket: string, path: string): string => {
  const base = baseUrl.replace(/\/$/, '')
  const encoded = path.split('/').map(encodeURIComponent).join('/')
  return `${base}/storage/v1/object/${bucket}/${encoded}`
}
