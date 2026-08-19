import { appUpdate } from '@/appUpdate.js'

/**
 * Registers the PWA service worker once per page load.
 *
 * Only runs in production builds — leaving HMR untouched in dev. The SW
 * file is served from the app's base URL (so it works under any
 * APP_BASE_PATH).
 *
 * Update behaviour (see also src/appUpdate.ts):
 *  - When a new SW reaches `installed` while an old one still controls the
 *    page, we flag the update. The SW self-`skipWaiting()`s in its own
 *    install handler (src/sw/sw.ts), so it activates in the background on
 *    its own — the `SKIP_WAITING` postMessage below is only a fallback for
 *    a worker that somehow didn't. We do NOT reload the page. The point is
 *    that the *next* load — whether the user clicks the Reload prompt or
 *    just reloads the tab on their own — is served by the new build in a
 *    single reload, instead of the new SW sitting "waiting" until every tab
 *    closes (which is why a plain reload used to keep serving the old build).
 *  - We then flag `appUpdate.markAvailable()` so the toast + status
 *    chip can offer a deliberate "Reload" without surprising the user.
 *  - Long-lived PWA tabs may never navigate, so the browser's implicit
 *    update check never fires. We poll `registration.update()` on an
 *    interval and when the tab regains focus / the device reconnects, so a
 *    deploy is noticed while the app is open rather than only on cold start.
 *
 * Registers immediately rather than on `load` so the SW can install as
 * early as possible and intercept the tail of the first-visit module
 * graph; the standard "wait for load" pattern would push registration
 * past the initial fetch storm and miss them all.
 */

// Re-check sw.js this often for tabs that stay open across a deploy.
const UPDATE_POLL_INTERVAL_MS = 30 * 60 * 1000

// The active registration, captured once register() resolves, so the
// `app.checkForUpdates` action can trigger an on-demand update check. This
// matters more under cache-first navigation (src/sw/worker.ts): a new deploy is
// otherwise only noticed on the interval poll or the next reload.
let activeRegistration: ServiceWorkerRegistration | undefined

export type AppUpdateCheckResult = 'update-found' | 'up-to-date' | 'no-worker' | 'error'

/**
 * Imperatively ask the browser to re-fetch sw.js and install it if it changed —
 * the same check the interval poll / visibilitychange / online listeners run,
 * exposed for the `app.checkForUpdates` action. A found update still flows
 * through the existing `updatefound` → `appUpdate.markAvailable()` path (the
 * reload toast); here we only classify the outcome for immediate feedback.
 */
export const checkForAppUpdate = async (): Promise<AppUpdateCheckResult> => {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker) return 'no-worker'
  const registration = activeRegistration ?? (await navigator.serviceWorker.getRegistration())
  if (!registration) return 'no-worker'
  try {
    await registration.update()
  } catch {
    return 'error'
  }
  return registration.installing || registration.waiting || appUpdate.isAvailable()
    ? 'update-found'
    : 'up-to-date'
}

export const registerServiceWorker = (): void => {
  if (!import.meta.env.PROD) return
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return

  const swUrl = `${import.meta.env.BASE_URL}sw.js`

  navigator.serviceWorker
    .register(swUrl, {scope: import.meta.env.BASE_URL})
    .then((registration) => {
      activeRegistration = registration
      // A worker that reaches `installed` *while another version already
      // controls the page* is a pending update. On the very first install
      // there's no controller yet, so that worker is the first version, not
      // an update — `navigator.serviceWorker.controller` is the guard.
      const onInstalled = (worker: ServiceWorker | null) => {
        if (!worker || worker.state !== 'installed') return
        if (!navigator.serviceWorker.controller) return
        // The SW self-skipWaiting()s on install, so it's already activating
        // in the background; this postMessage is just a fallback. Either way
        // the next reload is served fresh — we leave the reload to the user.
        worker.postMessage('SKIP_WAITING')
        appUpdate.markAvailable()
      }

      // A worker that installed during a previous visit but never activated
      // (the old SW kept control) is already sitting in `waiting`.
      onInstalled(registration.waiting)

      registration.addEventListener('updatefound', () => {
        const next = registration.installing
        if (!next) return
        next.addEventListener('statechange', () => onInstalled(next))
      })

      const checkForUpdate = () => {
        registration.update().catch(() => {})
      }
      setInterval(checkForUpdate, UPDATE_POLL_INTERVAL_MS)
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') checkForUpdate()
      })
      window.addEventListener('online', checkForUpdate)
    })
    .catch((err) => {
      console.warn('[sw] registration failed', err)
    })
}
