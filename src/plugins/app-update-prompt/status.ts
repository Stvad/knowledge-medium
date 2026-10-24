/**
 * Routes "a new app build is downloading / ready" onto the shared diagnostics
 * seam, so the status indicator shows it generically (an ambient dot + a
 * "Reload" row in the dropdown) instead of the chip hardcoding `appUpdate`.
 * Pairs with the toast in `index.tsx`; this is the quiet, always-there chip
 * presence.
 *
 * The actual reload is a normal global action (`app.reload`) the dropdown
 * button runs via `runActionById` — same indirection every diagnostic uses.
 */
import { RefreshCcw, RefreshCw } from 'lucide-react'
import { appUpdate, type AppUpdatePhase } from '@/appUpdate.js'
import { checkForAppUpdate } from '@/registerServiceWorker.js'
import { showInfo } from '@/utils/toast.js'
import { actionsFacet } from '@/extensions/core.js'
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
  // Only meaningful once a newer build has taken over — keep it out of the
  // palette otherwise (the chip's dropdown button still dispatches it regardless).
  isVisible: () => appUpdate.phase() === 'ready',
  handler: () => {
    appUpdate.reload()
  },
}

export const APP_CHECK_FOR_UPDATES_ACTION_ID = 'app.checkForUpdates'

// One transient toast, replaced in place by id as the check progresses.
const CHECK_TOAST_ID = 'app-update-check'

// Manually poke the SW update check. Navigation is cache-first (src/sw/worker.ts),
// so this — alongside the navigation check, the focus check and the 30-min poll —
// is how a user pulls a new build on demand. A found update then downloads and
// reloads the tab through appUpdate; this toast is just the immediate "what
// happened" feedback.
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
        ? 'Found a new version — the app reloads once it has downloaded.'
        : result === 'up-to-date'
          ? "You're on the latest version."
          : result === 'no-worker'
            ? "Update checks aren't active in this session."
            : "Couldn't check for updates — check your connection."
    showInfo(message, {id: CHECK_TOAST_ID, duration: 4000})
  },
}

// One stable snapshot ref per phase — the content never varies, so reusing it
// keeps the source's getSnapshot referentially stable (a useSyncExternalStore
// requirement; see useDiagnostics).
const PHASE_SNAPSHOTS: Record<AppUpdatePhase, DiagnosticSnapshot | null> = {
  current: null,
  downloading: {
    severity: 'info',
    summary: 'Downloading a new version',
  },
  ready: {
    severity: 'info',
    summary: 'A new version is ready — this tab reloads once you finish editing',
    actionId: APP_RELOAD_ACTION_ID,
    actionLabel: 'Reload now',
    nudge: true,
  },
}

const appUpdateDiagnosticSource: DiagnosticSourceContribution = {
  id: 'app-update',
  label: 'App update',
  subscribe: appUpdate.subscribe,
  getSnapshot: () => PHASE_SNAPSHOTS[appUpdate.phase()],
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
