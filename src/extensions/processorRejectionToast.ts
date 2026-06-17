/**
 * Generic routing of `ProcessorRejection` (thrown from `repo.tx`, fanned
 * out via `repo.onUserError`) to the toast layer.
 *
 * Core stays ignorant of any specific rejection: a plugin that emits a
 * `ProcessorRejection {code}` contributes a `rejectionToastFacet` entry
 * (see `@/plugins/alias/rejectionToast`); core just looks the code up and
 * renders it, falling back to the raw message for codes nobody claimed.
 *
 * Two-part wiring, because the subscriber must exist EARLY (the data layer
 * fans rejections out from the moment the repo exists, incl. bootstrap
 * writes) but the contributions only resolve once the app runtime is up:
 *   - `surfaceProcessorRejection` is subscribed at repo construction
 *     (`context/repo.tsx`). Before the runtime resolves, `activeContributions`
 *     is empty, so early rejections still surface via the raw-message
 *     fallback (and sonner queues them until the `<Toaster/>` mounts).
 *   - `rejectionToastSyncEffect` (an `appEffectsFacet` contribution) keeps
 *     `activeContributions` pointed at the resolved app runtime's facet,
 *     so once the UI is up the rich plugin handlers take over. Re-runs on
 *     runtime swap; same module-state-synced-by-effect pattern as
 *     `runAction`'s dispatcher and theme-toggle's registry.
 */
import type { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import {
  appEffectsFacet,
  rejectionToastFacet,
  type AppEffect,
  type RejectionToastContribution,
} from './core.ts'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { showCustom, showError } from '@/utils/toast.js'

/** Rejection toasts stay up longer than a transient notice — they're
 *  actionable (open / merge / pick a new name). */
const REJECTION_TOAST_DURATION_MS = 12000

/** Dispatch one rejection to the renderer contributed for its `code`,
 *  wrapping it in `showCustom`. An unknown code falls back to the raw
 *  message — better than swallowing silently; any new processor that
 *  throws `ProcessorRejection` surfaces SOMETHING until a plugin
 *  contributes a tailored toast. Pure (takes the contributions map) so
 *  the routing contract is unit-testable. */
export const routeProcessorRejection = (
  error: ProcessorRejection,
  repo: Repo,
  contributions: ReadonlyMap<string, RejectionToastContribution>,
): void => {
  const contribution = contributions.get(error.code)
  if (!contribution) {
    showError(error.message)
    return
  }
  showCustom(
    id => contribution.render(error, repo, id),
    {duration: REJECTION_TOAST_DURATION_MS},
  )
}

/** Contributions resolved from the live app runtime. Empty until
 *  `rejectionToastSyncEffect` runs (i.e. during bootstrap), which is why
 *  `routeProcessorRejection` falls back to the raw message then. */
let activeContributions: ReadonlyMap<string, RejectionToastContribution> = new Map()

/** Subscribed once at repo construction (`context/repo.tsx`). Reads the
 *  effect-synced snapshot so a single early subscriber covers both the
 *  bootstrap window (raw-message fallback) and normal operation (rich
 *  plugin toasts). */
export const surfaceProcessorRejection = (error: ProcessorRejection, repo: Repo): void =>
  routeProcessorRejection(error, repo, activeContributions)

/** Keeps `activeContributions` synced to the resolved app runtime's
 *  `rejectionToastFacet`. An app effect (not a mount) because there's no
 *  UI to render — the effect runner hands us the runtime and runs the
 *  returned cleanup on dispose / re-run. */
export const rejectionToastSyncEffect: AppEffect = {
  id: 'core.rejection-toast-sync',
  start: ({runtime}) => {
    activeContributions = runtime.read(rejectionToastFacet)
    return () => { activeContributions = new Map() }
  },
}

export const processorRejectionToastExtension: AppExtension = systemToggle({
  id: 'system:processor-rejection-toast',
  name: 'Transaction-error toasts',
  description: 'Renders rejected transactions (e.g. alias collisions) as their rich toasts. Disabling falls back to plain error messages.',
  essential: true,
}).of([
  appEffectsFacet.of(rejectionToastSyncEffect, {source: 'core'}),
])
