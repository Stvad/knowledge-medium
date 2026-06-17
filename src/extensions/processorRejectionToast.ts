/**
 * Generic routing of `ProcessorRejection` (thrown from `repo.tx`, fanned
 * out via `repo.onUserError`) to the toast layer.
 *
 * Core stays ignorant of any specific rejection: a plugin that emits a
 * `ProcessorRejection {code}` contributes a `rejectionToastFacet` entry
 * (see `@/plugins/alias/rejectionToast`); core looks the code up and
 * renders it, falling back to the raw message for codes nobody claimed.
 *
 * `surfaceProcessorRejection` is subscribed once at repo construction
 * (`context/repo.tsx`), so it covers rejections from the moment the repo
 * exists (incl. bootstrap writes). It reads the contributions straight
 * off `repo.facetRuntime` — which `AppRuntimeProvider` installs as the
 * full app runtime once React mounts. During bootstrap that runtime only
 * holds the UI-free data facets, so `rejectionToastFacet` resolves empty
 * and early rejections surface via the raw-message fallback (sonner
 * queues them until the `<Toaster/>` mounts). No separate sync effect or
 * mount: the repo's runtime already carries the contributions, and a
 * runtime swap (plugin toggle) is reflected on the next read for free.
 */
import type { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import { rejectionToastFacet, type RejectionToastContribution } from './core.ts'
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

/** Subscribed once at repo construction (`context/repo.tsx`). Reads the
 *  rejection-toast contributions off the repo's current runtime, so a
 *  single early subscriber covers both the bootstrap window (data-only
 *  runtime ⇒ empty ⇒ raw-message fallback) and normal operation (full
 *  app runtime ⇒ plugin toasts), and tracks plugin toggles for free. */
export const surfaceProcessorRejection = (error: ProcessorRejection, repo: Repo): void =>
  routeProcessorRejection(error, repo, repo.facetRuntime?.read(rejectionToastFacet) ?? new Map())
