import {
  SERVICE_WORKER_META_CACHE,
  previewDatabaseRecordUrl,
  previewIdFromBasePath,
} from '@/sw/previewDatabases.js'

// wa-sqlite's VFS caps pathnames at 64 chars (mxPathname in
// node_modules/@journeyapps/wa-sqlite/src/VFS.js). SQLite derives
// WAL/journal/shm paths from the dbFilename with suffixes up to ~10
// chars, so the base has to stay well under 64 or sqlite3_open_v2
// fails with "Filename too long" and no useful error. 7 (prefix) +
// 40 (user) + 3 (suffix) = 50 — safe headroom.
const MAX_USER_SEGMENT = 40

// v6 = baseline (OPFSCoopSync + multi-tabs on @powersync/web@1.38.1).
// History: v3 was the original IDB layout; v4 introduced OPFS; v5
// reverted to IDB to test whether the bucket-wipe pattern was
// OPFS-specific (it wasn't — wipes reproduce identically on both, so
// the cause is upstream of storage). v6 returns to the intended
// production setup: OPFSCoopSync for fast sync access handles + multi-
// tabs enabled. Each VFS bump gets a fresh filename so we don't reuse
// storage across backends.
// PR previews are served under /<repo>/pr-preview/pr-<n>/ on the SAME origin as
// production, and OPFS/IndexedDB is per-origin — so without a per-deploy namespace
// a signed-in preview would open production's REAL local DB, and any client schema
// change / migration / PowerSync bump in the PR would mutate it (the app is
// offline-first, so the local store is authoritative). Derive a namespace from
// the deploy path so previews get their own DB. Production (BASE_URL = /<repo>/)
// matches nothing here, so its filename stays byte-for-byte identical and
// existing users keep their data. The preview namespace uses `~`, which production
// sanitized user ids can never contain, so a production local-only name like
// `alice-pr-309` cannot collide with preview PR 309 user `alice`.
export const previewDbId = (base: string): string | null => {
  return previewIdFromBasePath(base)
}

export const dbFilenameForUser = (
  userId: string,
  base: string = import.meta.env.BASE_URL,
) => {
  const previewId = previewDbId(base)
  const previewNamespace = previewId ? `~${previewId}~` : ''
  // The preview namespace comes OUT of the user budget, so the base name stays
  // within the same envelope as production (`kmp-v6-` + <=MAX_USER_SEGMENT +
  // `.db` = 50) regardless of the namespace — preserving the headroom the 64-char
  // wa-sqlite pathname cap needs for the -journal/-wal/-shm derivatives.
  const sanitized = userId
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, Math.max(0, MAX_USER_SEGMENT - previewNamespace.length))
  return previewId
    ? `kmp-v6${previewNamespace}${sanitized}.db`
    : `kmp-v6-${sanitized}.db`
}

export const recordPreviewDatabaseForReaper = async (dbFilename: string): Promise<void> => {
  if (!previewDbId(import.meta.env.BASE_URL)) return
  if (typeof window === 'undefined' || typeof caches === 'undefined') return

  const scopeUrl = new URL(import.meta.env.BASE_URL, window.location.href)
  try {
    const cache = await caches.open(SERVICE_WORKER_META_CACHE)
    await cache.put(
      previewDatabaseRecordUrl(scopeUrl, dbFilename),
      new Response(JSON.stringify({name: dbFilename, updatedAt: Date.now()}), {
        headers: {'content-type': 'application/json'},
      }),
    )
  } catch {
    // Preview-local data is disposable; failing to record cleanup metadata should
    // not block opening the preview DB.
  }
}
