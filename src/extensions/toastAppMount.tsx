/**
 * App-mount contribution that renders the sonner `<Toaster />`.
 *
 * Mounted once via `appMountsFacet` so toast surfaces (long-running
 * import progress, alias-collision rejections, etc.) are themed
 * consistently and the lib choice stays a single grep target.
 *
 * Placement note: app mounts render inside `AppRuntimeProvider`,
 * which is itself inside the React tree once the user is signed in
 * and the Repo has bootstrapped. Toasts surfaced during bootstrap
 * (e.g. a Login failure) wouldn't render here — those go through
 * `ErrorBoundary` / `BootstrapErrorFallback` in `main.tsx`. The
 * trade is worth it: any toast that comes from a `repo.tx`
 * processor rejection or a user-initiated action only fires after
 * the runtime is up.
 */
import { Toaster } from 'sonner'
import { appMountsFacet } from './core.ts'
import type { AppExtension } from './facet.ts'
import { withSystemExtensionMetadata } from './togglable.ts'

export const ToastAppMount = () => (
  <Toaster position="top-center" richColors closeButton />
)

export const toastAppMountExtension: AppExtension = withSystemExtensionMetadata({
  name: 'Toasts',
  description: 'Mount point for transient notifications. Disabling silently drops every toast.',
}, [
  appMountsFacet.of(
    {id: 'core.toast', component: ToastAppMount},
    {source: 'core'},
  ),
])
