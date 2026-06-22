/**
 * A diagnostics source that surfaces "this origin's local storage isn't
 * persistent" as an ambient nudge on the status chip — the quiet, contextual
 * reminder (vs. nagging the raw browser prompt every load; see
 * src/requestPersistentStorage.ts).
 *
 * It's a small live store: it re-reads the persistence state and republishes a
 * `DiagnosticSnapshot` (ref-stable while unchanged). Persistence can flip to
 * granted later — the browser auto-grants on PWA install / enough engagement —
 * so it re-checks when the tab regains focus and clears the nudge on its own.
 */
import { getPersistenceState, subscribePersistenceChange } from '@/requestPersistentStorage.js'
import type {
  DiagnosticSnapshot,
  DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'

export const REQUEST_PERSISTENCE_ACTION_ID = 'storage.requestPersistence'

let snapshot: DiagnosticSnapshot | null = null
let started = false
const listeners = new Set<() => void>()

const notify = (): void => {
  for (const listener of listeners) listener()
}

const sameSnapshot = (a: DiagnosticSnapshot | null, b: DiagnosticSnapshot | null): boolean => {
  if (a === b) return true
  if (!a || !b) return false
  return (
    a.severity === b.severity &&
    a.summary === b.summary &&
    a.detail === b.detail &&
    a.actionId === b.actionId &&
    a.actionLabel === b.actionLabel &&
    a.nudge === b.nudge
  )
}

const computeSnapshot = (state: {
  supported: boolean
  persisted: boolean
  permission: PermissionState | undefined
}): DiagnosticSnapshot | null => {
  // Already protected, or an engine we can't query/act on (Safari, which applies
  // its own eviction rules) → nothing actionable to nudge about.
  if (state.persisted || !state.supported) return null
  if (state.permission === 'denied') {
    // The user explicitly blocked it; re-requesting would no-op (the browser
    // won't re-prompt), so inform rather than offer a dead button.
    return {
      severity: 'warning',
      summary: 'Storage access is blocked',
      detail: "Re-enable storage for this site in your browser's settings to keep local data from being evicted.",
      nudge: true,
    }
  }
  return {
    severity: 'warning',
    summary: "Local data isn't protected on this device",
    detail:
      'It could be evicted if the device runs low on storage. Protect it to keep your offline data and unsynced edits safe.',
    actionId: REQUEST_PERSISTENCE_ACTION_ID,
    actionLabel: 'Protect',
    nudge: true,
  }
}

/** Re-read the live persistence state and republish the snapshot when it changes. */
export const refreshPersistenceStatus = async (): Promise<void> => {
  const next = computeSnapshot(await getPersistenceState())
  if (sameSnapshot(snapshot, next)) return
  snapshot = next
  notify()
}

const onVisibilityChange = (): void => {
  if (document.visibilityState === 'visible') void refreshPersistenceStatus()
}

const start = (): void => {
  if (started) return
  started = true
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  // The boot request (or the manual Protect action) can settle after our first
  // read — e.g. a Firefox prompt grants late; re-check when it does so the
  // nudge clears without waiting for a focus change.
  subscribePersistenceChange(() => void refreshPersistenceStatus())
  void refreshPersistenceStatus()
}

export const persistenceDiagnosticSource: DiagnosticSourceContribution = {
  id: 'storage-persistence',
  label: 'Storage',
  subscribe: (listener) => {
    listeners.add(listener)
    start()
    return () => {
      listeners.delete(listener)
    }
  },
  getSnapshot: () => snapshot,
}
