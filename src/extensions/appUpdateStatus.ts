/**
 * Routes "a new app build is available" onto the shared diagnostics seam, so
 * the status indicator shows it generically (an ambient dot + a "Reload" row in
 * the dropdown) instead of the chip hardcoding `appUpdate`. Pairs with the
 * loud, dismissible toast in `appUpdateMount.tsx`; this is the quiet, always-
 * there chip presence.
 *
 * The actual reload is a normal global action (`app.reload`) the dropdown
 * button runs via `runActionById` — same indirection every diagnostic uses.
 */
import { RefreshCcw, RefreshCw } from 'lucide-react'
import { appUpdate } from '@/appUpdate.js'
import { checkForAppUpdate } from '@/registerServiceWorker.js'
import { showInfo } from '@/utils/toast.js'
import { actionsFacet } from './core.js'
import {
  diagnosticsFacet,
  type DiagnosticSnapshot,
  type DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'
import { ActionContextTypes, type ActionConfig } from '@/shortcuts/types.js'

export const APP_RELOAD_ACTION_ID = 'app.reload'

const appReloadAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: APP_RELOAD_ACTION_ID,
  description: 'Reload to apply the new version',
  context: ActionContextTypes.GLOBAL,
  icon: RefreshCw,
  // Only meaningful when an update is pending — keep it out of the palette
  // otherwise (the chip's dropdown button still dispatches it regardless).
  isVisible: () => appUpdate.isAvailable(),
  handler: () => {
    appUpdate.reload()
  },
}

export const APP_CHECK_FOR_UPDATES_ACTION_ID = 'app.checkForUpdates'

// One transient toast, replaced in place by id as the check progresses.
const CHECK_TOAST_ID = 'app-update-check'

// Manually poke the SW update check. Useful now that navigation is cache-first
// (src/sw/worker.ts): a new deploy no longer appears on the next navigation, so
// this — alongside the 30-min poll — is how a user pulls a new build on demand.
// A found update still surfaces the persistent reload prompt via the existing
// updatefound → appUpdate.markAvailable() path; this toast is just the immediate
// "what happened" feedback.
const appCheckForUpdatesAction: ActionConfig<typeof ActionContextTypes.GLOBAL> = {
  id: APP_CHECK_FOR_UPDATES_ACTION_ID,
  description: 'Check for updates',
  context: ActionContextTypes.GLOBAL,
  icon: RefreshCcw,
  // Hidden where there's no service worker to ask (dev, unsupported browsers).
  isVisible: () => typeof navigator !== 'undefined' && !!navigator.serviceWorker,
  handler: async () => {
    showInfo('Checking for updates…', {id: CHECK_TOAST_ID, duration: Number.POSITIVE_INFINITY})
    const result = await checkForAppUpdate()
    const message =
      result === 'update-found'
        ? 'A new version is available — reload to apply.'
        : result === 'up-to-date'
          ? "You're on the latest version."
          : result === 'no-worker'
            ? "Update checks aren't active in this session."
            : "Couldn't check for updates — check your connection."
    showInfo(message, {id: CHECK_TOAST_ID, duration: 4000})
  },
}

// One stable snapshot ref — the content never varies, so reusing it keeps the
// source's getSnapshot referentially stable while an update is pending (a
// useSyncExternalStore requirement; see useDiagnostics).
const UPDATE_AVAILABLE_SNAPSHOT: DiagnosticSnapshot = {
  severity: 'info',
  summary: 'A new version is available',
  actionId: APP_RELOAD_ACTION_ID,
  actionLabel: 'Reload',
  nudge: true,
}

const appUpdateDiagnosticSource: DiagnosticSourceContribution = {
  id: 'app-update',
  label: 'App update',
  subscribe: appUpdate.subscribe,
  getSnapshot: () => (appUpdate.isAvailable() ? UPDATE_AVAILABLE_SNAPSHOT : null),
}

export const appReloadActionContribution = actionsFacet.of(appReloadAction, {
  source: 'app-update',
})

export const appCheckForUpdatesActionContribution = actionsFacet.of(appCheckForUpdatesAction, {
  source: 'app-update',
})

export const appUpdateDiagnosticContribution = diagnosticsFacet.of(appUpdateDiagnosticSource, {
  source: 'app-update',
})
