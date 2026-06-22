/**
 * Ask the browser to make this origin's storage *persistent* so it's exempt
 * from automatic eviction under storage pressure.
 *
 * Why: the app is local-first and keeps significant state in the origin's
 * default storage bucket — the SQLite database (OPFS, via PowerSync /
 * wa-sqlite), the per-workspace E2EE workspace-key store (IndexedDB
 * `km-e2ee-keys`), and (planned) media caches. Under the WHATWG Storage
 * Standard that whole bucket is "best-effort" by default: the browser may
 * evict it when the device runs low on space. Losing the local SQLite DB is
 * the most painful failure — it can hold unsynced edits and local-only history
 * the server has never seen — so we ask once, at boot, for persistence.
 *
 * `navigator.storage.persist()` is origin-wide and all-or-nothing: it makes
 * the *entire* default bucket persistent (never auto-evicted; cleared only by
 * an explicit user action like clearing site data). It may be granted silently
 * via the browser's engagement / installed-PWA heuristics, or — in some
 * browsers (e.g. Firefox) — prompt the user. We therefore:
 *   - check {@link StorageManager.persisted} first, so an origin that is
 *     already persistent doesn't re-request (and we don't risk an unnecessary
 *     prompt), and
 *   - make exactly one attempt per page load — no nagging.
 *
 * See `docs/storage-persistence.md` for the durability model and the (not yet
 * built) Storage Buckets API path for differential durability.
 *
 * @returns whether storage is persistent after this call (already-granted or
 *   newly granted both resolve `true`).
 */
export const requestPersistentStorage = async (): Promise<boolean> => {
  if (typeof navigator === 'undefined') return false

  const storage = navigator.storage
  // Safari < 15.4 and other older engines lack the StorageManager
  // persist/persisted methods. We can't query or request persistence there;
  // such engines apply their own platform rules, so just no-op.
  if (
    !storage ||
    typeof storage.persist !== 'function' ||
    typeof storage.persisted !== 'function'
  ) {
    return false
  }

  try {
    if (await storage.persisted()) {
      console.info('[storage] already persistent — exempt from automatic eviction')
      return true
    }

    const granted = await storage.persist()
    if (granted) {
      console.info('[storage] persistence granted — origin exempt from automatic eviction')
    } else {
      console.warn(
        '[storage] persistence not granted — local data (SQLite DB, workspace keys) ' +
          'may be evicted under storage pressure. The browser may grant it later as ' +
          'site engagement grows or once the app is installed as a PWA.',
      )
    }
    return granted
  } catch (err) {
    // Never let a storage-permission hiccup take down boot.
    console.warn('[storage] persistence request failed', err)
    return false
  }
}
