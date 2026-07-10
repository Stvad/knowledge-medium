/**
 * Global surface for extension trust prompts (issue #67 follow-up): the
 * `needs-approval` / `update-available` statuses used to render ONLY inside
 * the Extensions settings page. This app-mount surfaces them everywhere —
 * one persistent toast per pending extension, plus (via
 * `extensionPromptStatus.ts`) a quiet status-chip indicator.
 *
 * Mirrors the app-BUILD update surface (`appUpdateMount.tsx` +
 * `appUpdateStatus.ts`): a loud, dismissible toast paired with an always-
 * there chip indicator. The difference is that there are N extensions, so:
 *
 *   - Each toast is keyed by `ext-approval:<blockId>` and its Enable/Update
 *     and Dismiss buttons act on THAT block only — fixing the reported bug
 *     where enabling one extension dismissed a different one's prompt.
 *   - Dismiss persists per-extension (device-local, pinned to the source
 *     hash) so it survives reloads; the extension still shows in settings
 *     with a working Enable/Update button.
 *
 * Dismiss model (design C): a toast renders only for NON-dismissed prompts,
 * so Dismiss silences the loud nag. But the chip diagnostic is fed the FULL
 * pending set (dismissed included) — dismissing drops the toast and the
 * chip's ambient dot, yet leaves a quiet "Review" row as a breadcrumb.
 *
 * The driver reads the per-provider approval store (via context) — so it
 * lives under `AppRuntimeProvider` — and publishes the full pending set into
 * the `extensionPromptStore` singleton the chip diagnostic reads.
 */
import {useEffect, useMemo, useRef} from 'react'
import {useRepo} from '@/context/repo.js'
import {useExtensionApprovalStatuses} from '@/extensions/extensionApprovalStatus.js'
import {approveExtensionHere} from '@/extensions/approveExtensionHere.js'
import {
  extensionPromptDismissals,
  useExtensionPromptDismissals,
} from '@/extensions/extensionPromptDismissals.js'
import {
  pendingExtensionPrompts,
  extensionPromptStore,
  type PendingExtensionPrompt,
} from '@/extensions/extensionPromptStore.js'
import {extensionPromptDiagnosticContribution} from '@/extensions/extensionPromptStatus.js'
import {refreshAppRuntime} from '@/facets/runtimeEvents.js'
import {dismissToast, showInfo} from '@/utils/toast.js'
import {appMountsFacet} from './core.ts'
import type {AppExtension} from '@/facets/facet.js'
import type {Repo} from '@/data/repo'
import {systemToggle} from '@/facets/togglable.js'

const toastId = (blockId: string): string => `ext-approval:${blockId}`

/** A prompt's toast content signature — reshow only when this changes, so an
 *  unchanged toast isn't torn down and re-animated on every re-publish. */
const toastSignature = (prompt: PendingExtensionPrompt): string =>
  `${prompt.kind}:${prompt.liveHash}`

const promptMessage = (prompt: PendingExtensionPrompt): string =>
  prompt.kind === 'needs-approval'
    ? `“${prompt.name}” isn't enabled on this device`
    : `“${prompt.name}” has an update available`

const primaryLabel = (prompt: PendingExtensionPrompt): string =>
  prompt.kind === 'needs-approval' ? 'Enable' : 'Update'

const showPromptToast = (repo: Repo, prompt: PendingExtensionPrompt): void => {
  showInfo(promptMessage(prompt), {
    id: toastId(prompt.blockId),
    duration: Number.POSITIVE_INFINITY,
    action: {
      label: primaryLabel(prompt),
      onClick: (event) => {
        // Keep the toast open: sonner dismisses a toast on any action click
        // (scheduling an id-keyed removal ~200ms later), so a re-show under
        // the same id would just lose that race for fast failures. Instead we
        // own dismissal — on success the runtime refresh clears the status and
        // the reconcile effect dismisses the toast; on failure it simply stays
        // put as the retry affordance (the error was already surfaced by
        // approveExtensionHere).
        event?.preventDefault()
        void approveExtensionHere(repo, prompt.blockId, prompt.name).then((ok) => {
          if (!ok) return
          // A fresh approval supersedes any earlier dismissal so a future
          // update can nudge again (and localStorage stays tidy).
          extensionPromptDismissals.clear(prompt.blockId)
          // Re-resolve so the loader picks up the now-approved source; the
          // status clears, the prompt leaves the set, and the reconcile effect
          // below dismisses the toast.
          refreshAppRuntime()
        })
      },
    },
    cancel: {
      label: 'Dismiss',
      onClick: () =>
        extensionPromptDismissals.dismiss(prompt.blockId, prompt.liveHash),
    },
  })
}

export const ExtensionPromptSurface = () => {
  const repo = useRepo()
  const statuses = useExtensionApprovalStatuses()
  const dismissals = useExtensionPromptDismissals()

  // Every pending prompt, tagged with whether it's been dismissed.
  const pending = useMemo(
    () => pendingExtensionPrompts(statuses, dismissals),
    [statuses, dismissals],
  )
  // Toasts are the loud nag — only the non-dismissed prompts get one.
  const toasts = useMemo(() => pending.filter((p) => !p.dismissed), [pending])

  // Feed the status-chip diagnostic (which has no React context to reach the
  // per-provider approval store) the FULL set: a dismissed prompt still shows
  // as a quiet row, it just stops nudging (see extensionPromptStatus.ts).
  useEffect(() => {
    extensionPromptStore.set(pending)
  }, [pending])

  // Reconcile toasts against the non-dismissed set: (re)show each prompt whose
  // content changed, dismiss toasts whose prompt is gone (enabled or
  // dismissed). `shown` maps toast id → last-shown signature.
  const shown = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    const next = new Map<string, string>()
    for (const prompt of toasts) {
      const id = toastId(prompt.blockId)
      const signature = toastSignature(prompt)
      next.set(id, signature)
      if (shown.current.get(id) !== signature) showPromptToast(repo, prompt)
    }
    for (const id of shown.current.keys()) {
      if (!next.has(id)) dismissToast(id)
    }
    shown.current = next
  }, [toasts, repo])

  // On unmount (plugin toggled off), clear the published set AND dismiss any
  // still-open toasts. They have infinite duration and live in Sonner's
  // portal — not this component's tree — so without this they'd stay visible
  // and actionable after the surface is gone (mirrors appUpdateMount's
  // dismiss-on-unmount).
  useEffect(
    () => () => {
      extensionPromptStore.set([])
      for (const id of shown.current.keys()) dismissToast(id)
      shown.current.clear()
    },
    [],
  )

  return null
}

export const extensionPromptsExtension: AppExtension = systemToggle({
  id: 'system:extension-prompts',
  name: 'Extension prompts',
  description:
    'Surfaces extensions that need enabling or have an update outside the settings page — a per-extension toast plus a quiet indicator in the status chip.',
}).of([
  appMountsFacet.of(
    {id: 'core.extension-prompts', component: ExtensionPromptSurface},
    {source: 'core'},
  ),
  extensionPromptDiagnosticContribution,
])
