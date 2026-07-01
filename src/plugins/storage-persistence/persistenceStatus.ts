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
import { CallbackSet } from '@/utils/callbackSet.js'
import type {
  DiagnosticSnapshot,
  DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'

export const REQUEST_PERSISTENCE_ACTION_ID = 'storage.requestPersistence'

let snapshot: DiagnosticSnapshot | null = null
let started = false
// Monotonic refresh id: overlapping refreshes (the initial read vs. a
// change-signal/focus refresh) can resolve out of order, so a stale read must
// not clobber a newer one. The latest-*started* refresh wins.
let refreshSeq = 0
const listeners = new CallbackSet('persistence-status')

const notify = (): void => listeners.notify()

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
  // Already protected, or an engine without the persist API (very old
  // browsers, which apply their own eviction rules) → nothing to nudge about.
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
  const seq = ++refreshSeq
  const next = computeSnapshot(await getPersistenceState())
  // A newer refresh started while we awaited — discard this (possibly stale)
  // result so it can't overwrite the fresher one (e.g. the initial
  // not-persisted read resolving after a late grant already cleared the nudge).
  if (seq !== refreshSeq) return
  if (sameSnapshot(snapshot, next)) return
  snapshot = next
  notify()
}

const onVisibilityChange = (): void => {
  if (document.visibilityState === 'visible') void refreshPersistenceStatus()
}

// Handle to the persistence-change subscription, so stop() can release it.
let unsubscribeChange: (() => void) | null = null

const start = (): void => {
  if (started) return
  started = true
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange)
  }
  // The boot request (or the manual Protect action) can settle after our first
  // read — e.g. a Firefox prompt grants late; re-check when it does so the
  // nudge clears without waiting for a focus change.
  unsubscribeChange = subscribePersistenceChange(() => void refreshPersistenceStatus())
  void refreshPersistenceStatus()
}

const stop = (): void => {
  if (!started) return
  started = false
  if (typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  unsubscribeChange?.()
  unsubscribeChange = null
}

/** Test-only reset of the module store (mirrors data-integrity's
 *  resetConsistencyAuditStore). Detaches listeners and clears state. */
export const resetPersistenceStatus = (): void => {
  stop()
  listeners.clear()
  snapshot = null
  refreshSeq = 0
}

export const persistenceDiagnosticSource: DiagnosticSourceContribution = {
  id: 'storage-persistence',
  label: 'Storage',
  subscribe: (listener) => {
    const off = listeners.add(listener)
    start()
    return () => {
      off()
      // Last subscriber gone — detach the document/change listeners so we don't
      // leak across plugin toggles / HMR (and so a disabled chip stops working).
      if (listeners.size === 0) stop()
    }
  },
  getSnapshot: () => snapshot,
}
