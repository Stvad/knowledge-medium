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
import { RefreshCw } from 'lucide-react'
import { appUpdate } from '@/appUpdate.js'
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
  handler: () => {
    appUpdate.reload()
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

export const appUpdateDiagnosticContribution = diagnosticsFacet.of(appUpdateDiagnosticSource, {
  source: 'app-update',
})
