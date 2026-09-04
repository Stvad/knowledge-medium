/*
 * The mirror's health on the shared status chip.
 *
 * Without this the feature fails silently: the user opts in once and never
 * opens the settings again, so a folder grant that lapses — or a full disk —
 * would stop the copies with nothing to notice. The chip is where the app
 * already says "look here".
 *
 * Reports nothing at all while mirroring is off, which is the default: a
 * feature the user has not asked for is not a health signal.
 */
import type {
  DiagnosticSnapshot,
  DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'
import {dbMirrorStore, type DbMirrorState} from './store.js'

/** Declared here rather than beside the action so this module — which every
 *  status read pulls in — does not drag the settings dialog's React tree along
 *  with it. Same arrangement as `storage-persistence`. */
export const OPEN_DB_MIRROR_SETTINGS_ACTION_ID = 'open_db_mirror_settings'

const openSettings = {
  actionId: OPEN_DB_MIRROR_SETTINGS_ACTION_ID,
  actionLabel: 'Settings',
} as const

const describeLastCopy = (state: DbMirrorState): string =>
  state.status.lastMirrorAt
    ? `Last copy ${new Date(state.status.lastMirrorAt).toLocaleString()}`
    : 'No copy taken yet'

export const dbMirrorDiagnostic = (state: DbMirrorState | null): DiagnosticSnapshot | null => {
  if (!state || !state.settings.enabled) return null
  if (state.status.permissionLost) {
    return {
      severity: 'warning',
      summary: 'Database mirror is paused',
      detail: state.status.lastError,
      nudge: true,
      ...openSettings,
    }
  }
  if (!state.directory) {
    return {
      severity: 'warning',
      summary: 'Database mirror has no folder',
      detail: 'Mirroring is on but no folder is chosen on this device, so nothing is being copied.',
      nudge: true,
      ...openSettings,
    }
  }
  if (state.status.lastError) {
    return {
      severity: 'warning',
      summary: 'Last database mirror failed',
      detail: state.status.lastError,
      nudge: true,
      ...openSettings,
    }
  }
  if (!state.status.lastMirrorAt) {
    // Turned on, folder chosen, nothing copied yet. Runs wait for a genuinely
    // idle main thread with no deadline, so this can hold for a whole busy
    // session — reporting it as healthy would claim a backup that does not
    // exist. No nudge: it is the ordinary state for the first minutes after
    // turning it on, and an ambient dot for that would be crying wolf.
    return {
      severity: 'warning',
      summary: 'Database mirror has not copied yet',
      detail: 'Waiting for a quiet moment to write the first copy to the chosen folder.',
      ...openSettings,
    }
  }
  return {
    severity: 'ok',
    summary: 'Database mirror is on',
    detail: describeLastCopy(state),
    ...openSettings,
  }
}

/** The chip re-reads through `useSyncExternalStore`, which compares by
 *  identity — so one snapshot per store state, cached. */
let cachedFrom: DbMirrorState | null = null
let cached: DiagnosticSnapshot | null = null

export const dbMirrorDiagnosticSource: DiagnosticSourceContribution = {
  id: 'db-mirror',
  label: 'Database mirror',
  subscribe: (listener) => dbMirrorStore.subscribe(listener),
  getSnapshot: () => {
    const state = dbMirrorStore.getSnapshot()
    if (state !== cachedFrom) {
      cachedFrom = state
      cached = dbMirrorDiagnostic(state)
    }
    return cached
  },
}
