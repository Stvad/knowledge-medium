import { appUpdate, type AppUpdate } from '@/appUpdate.js'

/**
 * Registers the PWA service worker once per page load.
 *
 * Only runs in production builds — leaving HMR untouched in dev. The SW
 * file is served from the app's base URL (so it works under any
 * APP_BASE_PATH).
 *
 * How a deploy reaches an open tab (see also src/appUpdate.ts):
 *  - The shell is served cache-first by the installed worker, so the load
 *    that DETECTS a deploy (the browser re-fetches sw.js on navigation) still
 *    boots the build that was installed. That keeps boot fast and offline.
 *  - The new worker installs in the background (`downloading`) and
 *    self-`skipWaiting()`s (src/sw/sw.ts). Activation hands it every open tab
 *    of this scope at once, firing `controllerchange` in each; each tab then
 *    prompts for a reload (`ready`). A tab of the new build keeps off the
 *    local database until every tab of the old one has reloaded or closed
 *    (src/data/localDbBuildGate.ts).
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
// `app.checkForUpdates` action can trigger an on-demand update check.
let activeRegistration: ServiceWorkerRegistration | undefined

export type AppUpdateCheckResult = 'update-found' | 'up-to-date' | 'no-worker' | 'error'

/**
 * Imperatively ask the browser to re-fetch sw.js and install it if it changed —
 * the same check the interval poll / visibilitychange / online listeners run,
 * exposed for the `app.checkForUpdates` action. A found update still flows
 * through {@link watchServiceWorkerUpdates}; here we only classify the outcome
 * for immediate feedback.
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
  return registration.installing || registration.waiting || appUpdate.phase() !== 'current'
    ? 'update-found'
    : 'up-to-date'
}

type WatchedWorker = Pick<ServiceWorker, 'state' | 'postMessage' | 'addEventListener'>
type WatchedContainer = Pick<ServiceWorkerContainer, 'addEventListener'> & {
  readonly controller: unknown
}
type WatchedRegistration = Pick<ServiceWorkerRegistration, 'addEventListener'> & {
  readonly installing: WatchedWorker | null
  readonly waiting: WatchedWorker | null
}

/** Feed the registration's lifecycle into {@link appUpdate}. */
export const watchServiceWorkerUpdates = async (
  container: WatchedContainer,
  registering: Promise<WatchedRegistration>,
  update: AppUpdate = appUpdate,
): Promise<void> => {
  // The worker is never told to claim, so a controller only changes when a
  // newer one activates over the one that served this page. Listening before
  // the registration resolves, so a takeover during that wait still counts.
  container.addEventListener('controllerchange', () => update.markReady())
  const registration = await registering

  const track = (worker: WatchedWorker): void => {
    // With no controller this is the first install, not an update.
    if (!container.controller) return
    update.markDownloading()
    const onState = (): void => {
      // The worker skips waiting on its own (sw.ts); this is a fallback.
      if (worker.state === 'installed') worker.postMessage('SKIP_WAITING')
      if (worker.state === 'redundant' && !registration.installing && !registration.waiting) {
        update.markDownloadFailed()
      }
    }
    worker.addEventListener('statechange', onState)
    onState()
  }

  // A worker that installed during a previous visit but never activated.
  if (registration.waiting) track(registration.waiting)
  if (registration.installing) track(registration.installing)
  registration.addEventListener('updatefound', () => {
    if (registration.installing) track(registration.installing)
  })
}

export const registerServiceWorker = (): void => {
  if (!import.meta.env.PROD) return
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return

  const swUrl = `${import.meta.env.BASE_URL}sw.js`

  const registering = navigator.serviceWorker.register(swUrl, {scope: import.meta.env.BASE_URL})
  watchServiceWorkerUpdates(navigator.serviceWorker, registering)
    .then(() => registering)
    .then((registration) => {
      activeRegistration = registration

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
