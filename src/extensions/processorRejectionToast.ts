/**
 * Generic routing of `ProcessorRejection` (thrown from `repo.tx` and
 * surfaced via `repo.onUserError`) to the toast layer.
 *
 * Core stays ignorant of any specific rejection: a plugin that emits a
 * `ProcessorRejection {code}` contributes a `rejectionToastFacet` entry
 * for that code (see `@/plugins/alias/rejectionToast`), and the mount
 * below dispatches each rejection to its registered handler — falling
 * back to the raw message for codes nobody claimed. This inverts the
 * old design, where this module imported plugin-specific toasts directly.
 *
 * The mount lives in the app runtime (not Repo bootstrap) because that's
 * where the resolved facet is readable; toasts can't render before the
 * runtime mounts anyway (the `<Toaster/>` mount has the same lifetime —
 * see `toastAppMount.tsx`).
 */
import { useEffect } from 'react'
import type { ProcessorRejection } from '@/data/api'
import type { Repo } from '@/data/repo'
import { keyedMapFacet, type AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { appMountsFacet } from './core.ts'
import { useRepo } from '@/context/repo.js'
import { useAppRuntime } from '@/extensions/runtimeContext.js'
import { showError } from '@/utils/toast.js'

/** Plugin-contributed handler for the rejection `code` it emits. Owns the
 *  whole user-facing presentation (copy, custom toast body, duration), so
 *  core never learns a specific rejection's shape. */
export interface RejectionToastContribution {
  /** `ProcessorRejection.code` this handler surfaces. */
  code: string
  /** Show the toast for `error`. `repo` is supplied so action buttons
   *  (navigate, merge, …) can dispatch without each handler capturing it. */
  handle: (error: ProcessorRejection, repo: Repo) => void
}

export const rejectionToastFacet = keyedMapFacet<RejectionToastContribution>(
  'core.rejectionToasts',
  c => c.code,
)

/** Dispatch one rejection to the handler contributed for its `code`. An
 *  unknown code falls back to the raw message — better than swallowing
 *  silently; any new processor that throws `ProcessorRejection` surfaces
 *  SOMETHING until a plugin contributes a tailored handler. Pure (no
 *  React) so the routing contract is unit-testable. */
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
  contribution.handle(error, repo)
}

/** Invisible app-mount that wires `repo.onUserError` to the contributed
 *  handlers. Re-subscribes when the runtime swaps so a freshly
 *  toggled-in plugin's handler is picked up. */
const ProcessorRejectionToastMount = (): null => {
  const repo = useRepo()
  const runtime = useAppRuntime()
  useEffect(
    () => repo.onUserError(error =>
      routeProcessorRejection(error, repo, runtime.read(rejectionToastFacet)),
    ),
    [repo, runtime],
  )
  return null
}

export const processorRejectionToastExtension: AppExtension = systemToggle({
  id: 'system:processor-rejection-toast',
  name: 'Transaction-error toasts',
  description: 'Surfaces rejected transactions (e.g. alias collisions) as toasts. Disabling silently drops them.',
  essential: true,
}).of([
  appMountsFacet.of(
    {id: 'core.processor-rejection-toast', component: ProcessorRejectionToastMount},
    {source: 'core'},
  ),
])
