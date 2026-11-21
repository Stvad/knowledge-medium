import type { Repo, WorkspaceRematerialization } from '@/data/repo'
import { showInfo } from '@/utils/toast.js'

const toastIdFor = (workspaceId: string): string =>
  `workspace-rematerialization:${workspaceId}`

const rowCount = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? '' : 's'}`

/** Describe the outcome using the report's structured counts and gap state. */
export const describeWorkspaceRematerialization = (
  report: WorkspaceRematerialization,
  switchedWorkspace = false,
): string => {
  const prefix = switchedWorkspace
    ? 'Repair finished for the workspace you started in.'
    : 'Downloaded workspace data repair finished.'
  const details = [
    `${rowCount(report.applied, 'downloaded row')} reapplied locally.`,
    `Rows awaiting local verification: ${report.unappliedBefore} → ${report.unappliedAfter}.`,
  ]

  if (report.deferred > 0) {
    details.push(
      `${rowCount(report.deferred, 'downloaded row')} could not be applied because workspace information or encryption keys were unavailable.`,
    )
  }
  if (report.quarantined > 0) {
    details.push(
      `${rowCount(report.quarantined, 'downloaded row')} could not be applied because decryption failed; retrying alone will not fix this.`,
    )
  }
  if (report.remainingGap) {
    details.push(report.remainingGap.transient
      ? 'Sync is still catching up or the local view is still rebuilding.'
      : 'Some downloaded rows remain unverified locally.')
  } else {
    details.push('No rows remain awaiting local verification.')
  }

  return `${prefix} ${details.join(' ')}`
}

/** Rebuild the local workspace view once and report its structured outcome.
 *
 * This is a local derivation pass. It does not initiate the property migration.
 * The observer commits in independent windows, so a thrown error may follow
 * partial progress even though no report was returned.
 */
const repairAndReport = async (
  repo: Repo,
  workspaceId: string,
): Promise<WorkspaceRematerialization | null> => {
  const toastId = toastIdFor(workspaceId)
  showInfo('Rebuilding the local view of this workspace…', {
    id: toastId,
    duration: Number.POSITIVE_INFINITY,
  })

  try {
    const report = await repo.rematerializeWorkspace(workspaceId, {scope: 'unapplied'})
    showInfo(
      describeWorkspaceRematerialization(
        report,
        repo.activeWorkspaceId !== workspaceId,
      ),
      {id: toastId, duration: 15_000},
    )
    return report
  } catch (error) {
    console.error('[workspace-recovery] local repair failed', error)
    const switchedWorkspace = repo.activeWorkspaceId !== workspaceId
    showInfo(
      `${switchedWorkspace ? 'Repair failed for the workspace you started in. ' : ''}`
        + 'Local repair may have partially completed. No property migration was initiated by this repair.',
      {id: toastId, duration: 15_000},
    )
    return null
  }
}


type RepairResult = WorkspaceRematerialization | null
const repairs = new WeakMap<Repo, Map<string, Promise<RepairResult>>>()

/** Concurrent UI callers share the pass and its toast; completed runs are never cached. */
export const rematerializeWorkspaceWithFeedback = (
  repo: Repo,
  workspaceId: string,
): Promise<RepairResult> => {
  const workspaceRepairs = repairs.get(repo) ?? new Map<string, Promise<RepairResult>>()
  repairs.set(repo, workspaceRepairs)
  const current = workspaceRepairs.get(workspaceId)
  if (current) return current
  const pending = repairAndReport(repo, workspaceId).finally(() => {
    workspaceRepairs.delete(workspaceId)
  })
  workspaceRepairs.set(workspaceId, pending)
  return pending
}
