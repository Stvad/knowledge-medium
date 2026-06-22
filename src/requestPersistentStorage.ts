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
 *   - **Firefox** shows a permission prompt; an explicit "Block" is a durable
 *     denial, a dismissal leaves it undecided.
 *   - **Safari** lacks the API entirely (we no-op and let its platform rules
 *     apply).
 *
 * Two competing constraints follow, and we thread both:
 *   1. *Don't nag.* Re-calling `persist()` every page load would re-prompt a
 *      Firefox user who already saw the prompt. So we (a) treat a Permissions
 *      API `'denied'` state as a permanent skip — the strongest "user said no"
 *      signal — and (b) otherwise ask at most once per *browsing session*.
 *   2. *Don't permanently gate silent denials.* A Chromium silent denial
 *      reports `'prompt'` (never `'denied'`), so it never trips the permanent
 *      skip; and because the once-per-session guard lives in `sessionStorage`,
 *      a *new* session retries — letting persistence be granted later. (A
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

// Per-session marker (sessionStorage, not localStorage) that we've already
// asked this session — so a dismissed prompt isn't repeated on every reload,
// while a new session still retries. Deliberately NOT permanent: a Chromium
// silent denial must keep its retry path.
const SESSION_ATTEMPT_KEY = 'storage.persistAttempted'

const attemptedThisSession = (): boolean => {
  try {
    return globalThis.sessionStorage?.getItem(SESSION_ATTEMPT_KEY) !== null
  } catch {
    return false
  }
}

const markAttemptedThisSession = (): void => {
  try {
    globalThis.sessionStorage?.setItem(SESSION_ATTEMPT_KEY, '1')
  } catch {
    // Private-mode sessionStorage can throw; losing the guard only risks an
    // extra (still silent on Chromium) request, never data.
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

    if (!force) {
      // Durable, explicit user denial (e.g. Firefox "Block"): never auto-retry.
      // Chromium reports 'prompt' for a *silent* denial, so this does not gate
      // Chromium's retry path.
      if ((await queryPersistPermission()) === 'denied') {
        console.info('[storage] persistence previously denied by the user — not re-requesting')
        return false
      }
      // Otherwise ask at most once per session, so a dismissed prompt isn't
      // repeated on reloads. A new session retries (sessionStorage clears).
      if (attemptedThisSession()) return false
    }
    // Record before requesting so even a prompt the user *dismisses* counts as
    // this session's one attempt — the dismissal itself is the nag we avoid.
    markAttemptedThisSession()

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
