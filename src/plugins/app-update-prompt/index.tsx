/**
 * App-mount that says what a deploy is doing to this tab: a toast while the
 * new version downloads, then one with a Reload action once it has taken over.
 * Pairs with the status chip row (src/plugins/system-status): the toast is the
 * loud, dismissible nudge; the chip is the quiet, always-there fallback.
 *
 * We never reload on our own; the reload waits only for writes in flight
 * (src/appUpdate.ts). Both toasts share one id and `duration: Infinity`, so
 * each replaces the last and waits for the user instead of auto-dismissing.
 *
 * Distinct from the `update-indicator` plugin, which flags per-block
 * content edited by another user — this one is about the app build itself.
 *
 * Lives in the plugin layer (issue #493) because it contributes to
 * `diagnosticsFacet`, which `plugins/diagnostics/facet.ts` declares is
 * "deliberately NOT in core". It reads core's app-update signal
 * (`@/appUpdate`, `@/registerServiceWorker`) — plugin depending on core, the
 * sanctioned direction — instead of core reaching up into a plugin's facet.
 */
import { useEffect } from 'react'
import { appUpdate, useAppUpdatePhase } from '@/appUpdate.js'
import { dismissToast, showInfo } from '@/utils/toast.js'
import { appMountsFacet } from '@/extensions/core.js'
import {
  appCheckForUpdatesActionContribution,
  appReloadActionContribution,
  appUpdateDiagnosticContribution,
} from './status.js'
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'

const UPDATE_TOAST_ID = 'app-update-available'

const AppUpdatePrompt = () => {
  const phase = useAppUpdatePhase()
  useEffect(() => {
    if (phase === 'current') return
    if (phase === 'downloading') {
      showInfo('Downloading a new version of the app…', {
        id: UPDATE_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
      })
    } else {
      showInfo('A new version is ready. Reload to use it.', {
        id: UPDATE_TOAST_ID,
        duration: Number.POSITIVE_INFINITY,
        action: {label: 'Reload', onClick: () => appUpdate.reload()},
      })
    }
    return () => dismissToast(UPDATE_TOAST_ID)
  }, [phase])
  return null
}

export const appUpdatePromptExtension: AppExtension = systemToggle({
  id: 'system:app-update-prompt',
  name: 'App update prompt',
  description: 'Surfaces a newer app build as a reload prompt — a toast plus a quiet indicator in the status chip.',
}).of([
  appMountsFacet.of(
    {id: 'app-update-prompt.surface', component: AppUpdatePrompt},
    {source: 'app-update-prompt'},
  ),
  // The chip presence (ambient dot + "Reload" row) goes through the diagnostics
  // seam, not chip-hardcoded knowledge of appUpdate.
  appUpdateDiagnosticContribution,
  appReloadActionContribution,
  appCheckForUpdatesActionContribution,
])
