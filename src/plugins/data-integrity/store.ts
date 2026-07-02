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
//
// These results are ALSO the "last results" the on-demand results dialog
// (ConsistencyAuditDialog) reads, so it can be re-opened to inspect the last run
// WITHOUT paying for another full audit. Results are kept PER WORKSPACE (not a
// single slot) so a cadenced/manual audit for one workspace can't evict the
// result an already-open dialog for a *different* workspace is showing.
import { CallbackSet } from '@/utils/callbackSet.js'
import type { ConsistencyAuditResult } from './audit.js'

/** Id of the global action that runs the built-in audit on demand (registered by
 *  the system-status plugin in auditAction.ts, triggered from the command palette
 *  and the status dropdown via `runActionById`). Lives here so neither
 *  caller has to import the other's module graph. */
export const RUN_DATA_INTEGRITY_AUDIT_ACTION_ID = 'run_data_integrity_audit'

/** Id of the global action that RE-OPENS the results dialog for the last audit
 *  WITHOUT re-running it — reading the snapshot below. Registered alongside the
 *  run action by the system-status plugin; the status dropdown's "Inspect" button
 *  points here so viewing last results is cheap (no expensive re-scan). */
export const VIEW_DATA_INTEGRITY_AUDIT_ACTION_ID = 'view_data_integrity_audit'

let latest: ConsistencyAuditResult | null = null
// One entry per audited workspace, so results for different workspaces coexist.
const byWorkspace = new Map<string, ConsistencyAuditResult>()
const listeners = new CallbackSet('data-integrity-audit')

/** Publish a completed audit result and notify subscribers. */
export const publishConsistencyAudit = (result: ConsistencyAuditResult): void => {
  latest = result
  byWorkspace.set(result.workspaceId, result)
  listeners.notify()
}

/** Most-recently-published result, ANY workspace — the "current health" pointer
 *  the scheduling/diagnostics plumbing has always exposed. A stable reference
 *  until the next publish. Prefer `getConsistencyAuditSnapshotFor` when you care
 *  about a specific workspace (almost always). */
export const getConsistencyAuditSnapshot = (): ConsistencyAuditResult | null => latest

/** The last result FOR `workspaceId` — a stable reference until THAT workspace is
 *  re-audited, or null. This is the single place the "the store is per-workspace,
 *  scope it before use" invariant lives: a publish for another workspace does not
 *  change what this returns, so a subscriber keyed on it (a dialog, the
 *  diagnostics source) is never blanked by an unrelated audit. */
export const getConsistencyAuditSnapshotFor = (
  workspaceId: string | null | undefined,
): ConsistencyAuditResult | null =>
  (workspaceId != null ? byWorkspace.get(workspaceId) : undefined) ?? null

export const subscribeConsistencyAudit = (listener: () => void): (() => void) =>
  listeners.add(listener)

/** Test helper — clear the published results + listeners. */
export const resetConsistencyAuditStore = (): void => {
  latest = null
  byWorkspace.clear()
  listeners.clear()
}
