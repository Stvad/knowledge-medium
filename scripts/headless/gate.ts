import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {Repo, ViewGap} from '@/data/repo'
import {viewGapReadsOver} from '@/data/internals/syncObserver/reconcile'
import type {WorkspaceRole} from '@/types'
import {STALE_QUEUE_REASON} from './uploadHold'

type Admission = {role: WorkspaceRole} | ViewGap

export const startReadGate = (
  db: CommonPowerSyncDatabase, repo: Repo, workspaceId: string, baseline: number | undefined,
  open: (signal: AbortSignal) => Promise<void>, visibility: (open: boolean) => void,
  access = {writable: false, isUploadHeld: () => false},
) => {
  let reason: string | null = 'Checking workspace access'
  let role: WorkspaceRole | null = null
  let membershipId: string | null = null
  let admitted = false
  let preparation: AbortController | 'ready' | undefined
  let pending: Promise<void> | undefined
  let dirty = false
  let stopped = false

  /** Why this host may not write now, or null. Owns the Repo's read-only state. */
  function writeRefusal(): string | null {
    if (!access.writable) return 'the host is configured with writable: false'
    if (access.isUploadHeld()) return STALE_QUEUE_REASON
    if (role !== 'editor' && role !== 'owner') {
      return role === null ? 'the workspace is not open' : `the member role ${role} cannot write`
    }
    return null
  }

  function applyWritability() {
    repo.setReadOnly(writeRefusal() !== null)
  }

  function resetPreparation(nextRole: WorkspaceRole | null) {
    if (preparation instanceof AbortController) preparation.abort()
    preparation = undefined
    role = nextRole
    applyWritability()
  }

  function close(message: string) {
    resetPreparation(null)
    if (admitted) visibility(false)
    admitted = false
    reason = message
  }

  // A stalled namespace read must not block demotion, removal or shutdown.
  function startPreparation(nextRole: WorkspaceRole) {
    resetPreparation(nextRole)
    const attempt = new AbortController()
    preparation = attempt
    reason = 'Opening workspace data'
    void open(attempt.signal).then(() => {
      if (attempt.signal.aborted) return
      preparation = 'ready'
      wake()
    }, error => {
      if (attempt.signal.aborted) return
      close('Could not open workspace data')
      console.error(reason, error)
    })
  }

  async function readAdmission(): Promise<Admission> {
    // A membership checkpoint can also stage its entire workspace. Sample
    // permission and completeness from the same replica snapshot.
    return db.readTransaction(async tx => {
      const member = await tx.getOptional<{id: string, role: WorkspaceRole} | {id: null, role: null}>(
        `SELECT m.id, m.role FROM workspaces w LEFT JOIN workspace_members m
         ON m.workspace_id = w.id AND m.user_id = ? WHERE w.id = ?`, [repo.user.id, workspaceId])
      if (!member) return {reason: 'Waiting for the local workspace row', transient: false}
      if (member.id === null) return {reason: 'Waiting for the local member row', transient: false}
      // A re-invitation mints a new member id. Both changes can arrive
      // between refreshes, so the old admission and its watchers expire here.
      if (member.id !== membershipId) {
        close('Checking workspace access')
        membershipId = member.id
      }
      if (!admitted) {
        const stamp = db.currentStatus.lastSyncedAt?.getTime()
        if (stamp === undefined || stamp === baseline) {
          return {reason: 'Waiting for a checkpoint from this connection', transient: false}
        }
        const gap = await repo.workspaceViewGap(workspaceId, viewGapReadsOver(tx))
        if (gap) return gap
      }
      return {role: member.role}
    })
  }

  async function refresh() {
    let admission = await readAdmission()
    if ('reason' in admission && admission.transient) {
      close(admission.reason)
      await repo.flushSyncObserver()
      admission = await readAdmission()
    }
    if ('reason' in admission) {
      close(admission.reason)
      return
    }
    if (stopped) return
    if (role !== admission.role) {
      startPreparation(admission.role)
    } else if (preparation === 'ready') {
      reason = null
      if (!admitted) visibility(true)
      admitted = true
    }
  }

  function wake() {
    dirty = true
    pending ??= (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false
          await refresh()
        }
      } catch (error) {
        close('Could not check the workspace view')
        console.error(reason, error)
      } finally {
        pending = undefined
      }
    })()
    return pending
  }
  const offStatus = db.registerListener({statusChanged: wake})
  const offTables = db.onChange({onChange: wake}, {tables: ['workspaces', 'workspace_members', 'blocks_synced_changes', 'blocks_synced']})
  wake()
  return {
    reason: () => reason,
    writeRefusal,
    uploadHoldChanged: applyWritability,
    async readReason() {
      if (reason !== null) {
        if (!pending) wake()
        return reason
      }
      // A command can arrive before the role-change notification.
      await wake()
      return reason
    },
    async stop() {
      stopped = true
      offTables()
      offStatus()
      resetPreparation(null)
      await pending
    },
  }
}
