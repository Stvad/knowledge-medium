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
 * the server has never seen — so we ask for persistence.
 *
 * `navigator.storage.persist()` is origin-wide and all-or-nothing: it makes
 * the *entire* default bucket persistent (never auto-evicted; cleared only by
 * an explicit user action like clearing site data). How it resolves depends on
 * the engine:
 *   - **Chromium** never prompts — it grants silently from heuristics (site
 *     engagement, bookmarked, installed PWA, notifications permission…). A
 *     `false` here is a *silent* denial that a later call can flip to `true`
 *     as engagement grows or the app is installed.
 *   - **Safari (17+)** behaves like Chromium here — silent, heuristic, no
 *     prompt — so it needs no special-casing.
 *   - **Firefox** shows a permission prompt; an explicit "Block" is a durable
 *     denial, a dismissal leaves it undecided.
 *   - Engines that lack `persist()`/`persisted()` entirely (very old browsers)
 *     fall out of the generic feature-detect below and no-op — again, no
 *     per-engine branch.
 *
 * Two competing constraints follow, and we thread both:
 *   1. *Don't nag.* Re-calling `persist()` every page load would re-prompt a
 *      Firefox user who already saw the prompt. So we (a) treat a Permissions
 *      API `'denied'` state as a permanent skip — the strongest "user said no"
 *      signal (in practice Firefox-only; Chromium/Safari grant silently and
 *      never report `'denied'`) — and (b) otherwise ask at most once per
 *      *cooldown window*, recorded origin-wide so it's shared across tabs.
 *   2. *Don't permanently gate silent denials.* A Chromium/Safari silent denial
 *      reports `'prompt'` (never `'denied'`), so it never trips the permanent
 *      skip; and because the cooldown marker has an expiry, a later attempt
 *      retries — letting persistence be granted as engagement grows. (A
 *      grant the browser makes on its own, e.g. on PWA install, is caught up
 *      front by `persisted()`.)
 *
 * A deliberate, user-initiated retry (a future settings affordance that can
 * explain *why* first) passes `{force: true}` to bypass both gates.
 *
 * See `docs/storage-persistence.md` for the durability model and the (not yet
 * built) Storage Buckets API path for differential durability.
 *
 * @returns whether storage is persistent after this call (already-granted or
 *   newly granted both resolve `true`).
 */

// Origin-wide retry marker (localStorage — shared across tabs and PWA windows,
// unlike per-tab sessionStorage) with an *expiry*. Origin-wide so a dismissed
// Firefox prompt isn't repeated in a second tab; expiring so it isn't permanent
// — a silent Chromium/Safari denial retries once the window lapses (engagement
// grows over days anyway). A durable Firefox "Block" is handled separately via
// the Permissions API `'denied'` state, which never expires here.
const PERSIST_ATTEMPT_KEY = 'storage.persistAttemptedAt'
const RETRY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000 // one week

const attemptedWithinCooldown = (): boolean => {
  try {
    const raw = globalThis.localStorage?.getItem(PERSIST_ATTEMPT_KEY)
    if (!raw) return false
    const at = Number(raw)
    return Number.isFinite(at) && Date.now() - at < RETRY_COOLDOWN_MS
  } catch {
    return false
  }
}

const markAttempted = (): void => {
  try {
    globalThis.localStorage?.setItem(PERSIST_ATTEMPT_KEY, String(Date.now()))
  } catch {
    // Private-mode storage can throw; losing the guard only risks an extra
    // (still silent on Chromium/Safari) request, never data.
  }
}

/** The `persistent-storage` permission state, or `undefined` when the
 *  Permissions API can't answer for it (older Firefox, Safari). Best-effort:
 *  used only to make a durable `'denied'` a permanent skip. */
const queryPersistPermission = async (): Promise<PermissionState | undefined> => {
  try {
    const status = await navigator.permissions?.query({
      name: 'persistent-storage' as PermissionName,
    })
    return status?.state
  } catch {
    return undefined
  }
}

// Fires whenever a persist() request settles and may have changed the
// persisted state — so UI reflecting it (the status-chip reminder) can refresh
// without waiting for the next focus check. The boot request in main.tsx is
// fire-and-forget; on Firefox its grant can land *after* the chip first read
// "not protected" (persist() stays pending while the prompt is open), so the
// reminder needs this push to clear.
const changeListeners = new Set<() => void>()

/** Subscribe to persistence-state changes from a settled persist() request.
 *  Returns an unsubscribe. */
export const subscribePersistenceChange = (listener: () => void): (() => void) => {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

const notifyPersistenceChange = (): void => {
  for (const listener of changeListeners) listener()
}

export interface PersistenceState {
  /** Whether this engine exposes the StorageManager persist/persisted API. */
  supported: boolean
  /** Whether the origin's storage is currently persistent. */
  persisted: boolean
  /** The `persistent-storage` permission state, when queryable. A durable
   *  `'denied'` is an explicit user "no" (e.g. Firefox Block). */
  permission: PermissionState | undefined
}

/** Read-only snapshot of the current persistence state, for UI that reflects
 *  it (the status-chip reminder). Never throws; an unsupported engine reports
 *  `{supported: false}`. Distinct from {@link requestPersistentStorage}, which
 *  has the once-per-session request gating. */
export const getPersistenceState = async (): Promise<PersistenceState> => {
  if (typeof navigator === 'undefined') {
    return { supported: false, persisted: false, permission: undefined }
  }
  const storage = navigator.storage
  if (
    !storage ||
    typeof storage.persist !== 'function' ||
    typeof storage.persisted !== 'function'
  ) {
    return { supported: false, persisted: false, permission: undefined }
  }
  let persisted: boolean
  try {
    persisted = await storage.persisted()
  } catch {
    persisted = false
  }
  return { supported: true, persisted, permission: await queryPersistPermission() }
}

export const requestPersistentStorage = async (
  {force = false}: {force?: boolean} = {},
): Promise<boolean> => {
  if (typeof navigator === 'undefined') return false

  const storage = navigator.storage
  // Engines that lack the StorageManager persist/persisted methods (very old
  // browsers). We can't query or request persistence there; they apply their
  // own platform rules, so just no-op. Generic feature-detect, no per-engine
  // branch.
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

    if (!force) {
      // Durable, explicit user denial (e.g. Firefox "Block"): never auto-retry.
      // Chromium/Safari report 'prompt' for a *silent* denial, so this does not
      // gate their retry path.
      if ((await queryPersistPermission()) === 'denied') {
        console.info('[storage] persistence previously denied by the user — not re-requesting')
        return false
      }
      // Otherwise ask at most once per cooldown window, so a dismissed prompt
      // isn't repeated on reloads or in other tabs. The marker expires, so a
      // later attempt retries.
      if (attemptedWithinCooldown()) return false
    }
    // Record before requesting so even a prompt the user *dismisses* counts as
    // the attempt — the dismissal itself is the nag we avoid.
    markAttempted()

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
    // The request settled (possibly granting) after a UI read of the old state;
    // tell reminders to re-check.
    notifyPersistenceChange()
    return granted
  } catch (err) {
    // Never let a storage-permission hiccup take down boot.
    console.warn('[storage] persistence request failed', err)
    return false
  }
}
