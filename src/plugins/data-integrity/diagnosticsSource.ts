/**
 * The consistency audit's contribution to the diagnostics seam. Maps the latest
 * published `ConsistencyAuditResult` into a `DiagnosticSnapshot` the sync-status
 * chip can show generically — replacing the chip's old hardcoded knowledge of
 * the audit store/shape.
 */
import type { Repo } from '@/data/repo'
import type { ConsistencyAuditResult } from './audit.js'
import {
  RUN_DATA_INTEGRITY_AUDIT_ACTION_ID,
  getConsistencyAuditSnapshot,
  subscribeConsistencyAudit,
} from './store.js'
import type {
  DiagnosticSnapshot,
  DiagnosticSourceContribution,
} from '@/plugins/diagnostics/facet.js'

const anomalousChecks = (result: ConsistencyAuditResult): string[] =>
  Object.entries(result.checks)
    .filter(([, c]) => c.status === 'anomaly')
    .map(([name]) => name)

const erroredChecks = (result: ConsistencyAuditResult): string[] =>
  Object.entries(result.checks)
    .filter(([, c]) => c.status === 'error')
    .map(([name]) => name)

/** Pure mapping from an audit result to a diagnostic snapshot. Anomalies are an
 *  error (redden the chip); a check that couldn't run is a warning that stays in
 *  the dropdown without alarming (matching the pre-seam behavior). */
export const mapAuditToSnapshot = (result: ConsistencyAuditResult): DiagnosticSnapshot => {
  const anomalies = result.anomalies
  const errored = erroredChecks(result)
  const severity = anomalies > 0 ? 'error' : errored.length > 0 ? 'warning' : 'ok'
  const summary =
    anomalies > 0
      ? `${anomalies} ${anomalies === 1 ? 'issue' : 'issues'} found`
      : errored.length > 0
        ? `${errored.length} ${errored.length === 1 ? 'check' : 'checks'} couldn't run`
        : 'All checks passed'
  const detailParts: string[] = []
  const flagged = anomalousChecks(result)
  if (flagged.length) detailParts.push(flagged.join(', '))
  if (errored.length) detailParts.push(`couldn't run: ${errored.join(', ')}`)
  return {
    severity,
    summary,
    detail: detailParts.join(' · ') || undefined,
    actionId: RUN_DATA_INTEGRITY_AUDIT_ACTION_ID,
  }
}

/** Build the diagnostic source. The audit store is a module global holding the
 *  LAST audited workspace's result, so gate on the active workspace: a result
 *  for another workspace reports nothing (rather than the wrong counts) until
 *  this workspace's audit publishes. Memoized so getSnapshot is ref-stable. */
export const createDataIntegrityDiagnosticSource = (
  repo: Pick<Repo, 'activeWorkspaceId'>,
): DiagnosticSourceContribution => {
  let cachedKey = ''
  let cachedSnapshot: DiagnosticSnapshot | null = null
  return {
    id: 'data-integrity',
    label: 'Data integrity',
    subscribe: subscribeConsistencyAudit,
    getSnapshot: () => {
      const result = getConsistencyAuditSnapshot()
      const active = repo.activeWorkspaceId
      if (!result || result.workspaceId !== active) {
        const key = `none:${active ?? ''}`
        if (key !== cachedKey) {
          cachedKey = key
          cachedSnapshot = null
        }
        return cachedSnapshot
      }
      const key = `${result.workspaceId}:${result.checkedAt}:${result.anomalies}`
      if (key !== cachedKey) {
        cachedKey = key
        cachedSnapshot = mapAuditToSnapshot(result)
      }
      return cachedSnapshot
    },
  }
}
