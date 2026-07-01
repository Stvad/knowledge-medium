// In-memory observable for the latest built-in consistency-audit result (L3),
// so the UI (the status indicator) can react to it via the diagnostics seam.
// Framework-agnostic (no React) and kernel-safe (no env globals) — the audit
// scheduling effect publishes here on each completed run; the data-integrity
// diagnostic source reads it.
//
// In-memory by design: the audit runs once per workspace per session (cadence-
// gated by the scheduling effect), so the store is repopulated on every page
// load. There's no cross-reload persistence to manage — a fresh session
// re-derives the current health within a few seconds of opening.
import { CallbackSet } from '@/utils/callbackSet.js'
import type { ConsistencyAuditResult } from './audit.js'

/** Id of the global action that runs the built-in audit on demand (registered by
 *  the system-status plugin in auditAction.ts, triggered from the command palette
 *  and the status dropdown via `runActionById`). Lives here so neither
 *  caller has to import the other's module graph. */
export const RUN_DATA_INTEGRITY_AUDIT_ACTION_ID = 'run_data_integrity_audit'

let latest: ConsistencyAuditResult | null = null
const listeners = new CallbackSet('data-integrity-audit')

/** Publish a completed audit result and notify subscribers. */
export const publishConsistencyAudit = (result: ConsistencyAuditResult): void => {
  latest = result
  listeners.notify()
}

/** Current snapshot — a stable reference until the next publish (so it's safe
 *  for useSyncExternalStore). */
export const getConsistencyAuditSnapshot = (): ConsistencyAuditResult | null => latest

export const subscribeConsistencyAudit = (listener: () => void): (() => void) =>
  listeners.add(listener)

/** Test helper — clear the published result + listeners. */
export const resetConsistencyAuditStore = (): void => {
  latest = null
  listeners.clear()
}
