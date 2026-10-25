import { appUpdate } from '@/appUpdate.js'

/**
 * Registers the PWA service worker once per page load.
 *
 * Only runs in production builds — leaving HMR untouched in dev. The SW
 * file is served from the app's base URL (so it works under any
 * APP_BASE_PATH).
 *
 * Update behaviour (see also src/appUpdate.ts):
 *  - When a new SW reaches `activated` while an old one still controls the
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

// Installation finishes precaching; activation makes that build serve the next load.
const waitForWorkerActivation = (worker: ServiceWorker): Promise<boolean> =>
  new Promise(resolve => {
    const onStateChange = () => {
      if (worker.state === 'installed') worker.postMessage('SKIP_WAITING')
      if (worker.state !== 'activated' && worker.state !== 'redundant') return
      worker.removeEventListener('statechange', onStateChange)
      resolve(worker.state === 'activated')
    }
    worker.addEventListener('statechange', onStateChange)
    onStateChange()
  })

/**
 * Imperatively ask the browser to re-fetch sw.js and install it if it changed —
 * the same check the interval poll / visibilitychange / online listeners run,
 * exposed for the `app.checkForUpdates` action. Only report an update once it
 * can serve the next load, so the result's Reload action applies that build.
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
  const next = registration.installing ?? registration.waiting ??
    (registration.active?.state === 'activating' ? registration.active : null)
  if (next) return await waitForWorkerActivation(next) ? 'update-found' : 'error'
  return appUpdate.isAvailable() ? 'update-found' : 'up-to-date'
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
      // A worker that activates while another version controls the page is
      // an update. On the very first install
      // there's no controller yet, so that worker is the first version, not
      // an update — `navigator.serviceWorker.controller` is the guard.
      const onUpdate = (worker: ServiceWorker | null) => {
        if (!worker) return
        if (!navigator.serviceWorker.controller) return
        void waitForWorkerActivation(worker).then(activated => {
          if (activated) appUpdate.markAvailable()
        })
      }

      // A worker that installed during a previous visit but never activated
      // (the old SW kept control) is already sitting in `waiting`.
      onUpdate(registration.waiting ?? registration.installing)

      registration.addEventListener('updatefound', () => {
        onUpdate(registration.installing)
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
