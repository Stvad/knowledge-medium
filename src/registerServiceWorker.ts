/**
 * Registers the PWA service worker once per page load.
 *
 * Only runs in production builds — leaving HMR untouched in dev. The SW
 * file is served from the app's base URL (so it works under any
 * APP_BASE_PATH), and we tell new versions to skip waiting so updates
 * apply on the next navigation rather than only after every tab closes.
 */
export const registerServiceWorker = (): void => {
  if (!import.meta.env.PROD) return
  if (typeof window === 'undefined') return
  if (!('serviceWorker' in navigator)) return

  const swUrl = `${import.meta.env.BASE_URL}sw.js`

  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register(swUrl, {scope: import.meta.env.BASE_URL})
      .then((registration) => {
        const promote = (worker: ServiceWorker | null) => {
          if (worker && worker.state === 'installed' && navigator.serviceWorker.controller) {
            worker.postMessage('SKIP_WAITING')
          }
        }
        promote(registration.waiting)
        registration.addEventListener('updatefound', () => {
          const next = registration.installing
          if (!next) return
          next.addEventListener('statechange', () => promote(next))
        })
      })
      .catch((err) => {
        console.warn('[sw] registration failed', err)
      })
  })
}
