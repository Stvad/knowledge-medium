// In-memory observable for the latest built-in consistency-audit result (L3),
// so the UI (the sync-status indicator) can react to it. Framework-agnostic
// (no React) and kernel-safe (no env globals) — the Repo audit job publishes
// here on each completed run; a useSyncExternalStore hook reads it.
//
// In-memory by design: the audit runs once per workspace per session (the Repo
// gates re-runs with an in-memory cadence), so the store is repopulated on every
// page load. There's no cross-reload persistence to manage — a fresh session
// re-derives the current health within a few seconds of opening.
import type { ConsistencyAuditResult } from './consistencyAudit'

/** Id of the global action that runs the built-in audit on demand (registered in
 *  defaultShortcuts.ts, triggered from the command palette and the sync-status
 *  dropdown via `runActionById`). Lives here so neither caller has to import the
 *  other's module graph. */
export const RUN_DATA_INTEGRITY_AUDIT_ACTION_ID = 'run_data_integrity_audit'

let latest: ConsistencyAuditResult | null = null
const listeners = new Set<() => void>()

/** Publish a completed audit result and notify subscribers. */
export const publishConsistencyAudit = (result: ConsistencyAuditResult): void => {
  latest = result
  for (const listener of listeners) listener()
}

/** Current snapshot — a stable reference until the next publish (so it's safe
 *  for useSyncExternalStore). */
export const getConsistencyAuditSnapshot = (): ConsistencyAuditResult | null => latest

export const subscribeConsistencyAudit = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test helper — clear the published result + listeners. */
export const resetConsistencyAuditStore = (): void => {
  latest = null
  listeners.clear()
}
