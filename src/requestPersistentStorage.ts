import { clientLocalSettings } from '@/utils/ClientLocalSettings.js'

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
 * the server has never seen — so we ask once for persistence.
 *
 * `navigator.storage.persist()` is origin-wide and all-or-nothing: it makes
 * the *entire* default bucket persistent (never auto-evicted; cleared only by
 * an explicit user action like clearing site data). It may be granted silently
 * via the browser's engagement / installed-PWA heuristics (Chromium never
 * prompts), or — notably on Firefox — show a permission prompt.
 *
 * "Don't nag" is the load-bearing constraint here. Because the request can
 * prompt, and a denied/dismissed origin keeps `persisted() === false`, calling
 * `persist()` on every boot would re-prompt a user who already said no. So we
 * make the *automatic* request **at most once ever** per device:
 *   - check {@link StorageManager.persisted} first — an already-persistent
 *     origin needs nothing (and the browser may have auto-granted it later,
 *     e.g. on PWA install, without us asking again); and
 *   - otherwise request only if we haven't already recorded an attempt. A
 *     deliberate, user-initiated retry (a future settings affordance that can
 *     explain *why* first) passes `{force: true}` to bypass that gate.
 *
 * See `docs/storage-persistence.md` for the durability model and the (not yet
 * built) Storage Buckets API path for differential durability.
 *
 * @returns whether storage is persistent after this call (already-granted or
 *   newly granted both resolve `true`).
 */

// Device-local marker that the one automatic boot request has been made, so a
// user who denied/dismissed the prompt isn't re-prompted on every reload.
const PERSIST_ATTEMPTED_KEY = 'storage.persistAttempted'

export const requestPersistentStorage = async (
  {force = false}: {force?: boolean} = {},
): Promise<boolean> => {
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

    // Honor "one attempt, don't nag": skip the automatic request if a previous
    // boot already asked (and the browser hasn't granted it since). A
    // user-initiated retry passes force.
    if (!force && clientLocalSettings.has(PERSIST_ATTEMPTED_KEY)) {
      return false
    }
    // Record before requesting so even a prompt the user *dismisses* counts as
    // the one attempt — the dismissal itself is the nag we won't repeat.
    clientLocalSettings.set(PERSIST_ATTEMPTED_KEY, true)

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
