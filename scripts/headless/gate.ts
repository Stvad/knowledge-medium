import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {Repo, ViewGap} from '@/data/repo'
import {viewGapReadsOver} from '@/data/internals/syncObserver/reconcile'
import {getLocalMemberRole} from '@/data/workspaces'
import type {WorkspaceRole} from '@/types'

type Admission = {role: WorkspaceRole} | ViewGap

export const startReadGate = (
  db: CommonPowerSyncDatabase, repo: Repo, workspaceId: string, baseline: number | undefined,
  open: (signal: AbortSignal) => Promise<void>, visibility: (open: boolean) => void,
  access = {writable: false, isUploadHeld: () => false},
) => {
  let reason: string | null = 'Checking workspace access'
  let role: WorkspaceRole | null = null
  let admitted = false
  let preparation: AbortController | 'ready' | undefined
  let pending: Promise<void> | undefined
  let dirty = false
  let stopped = false

  function applyWritability() {
    repo.setReadOnly(!(access.writable && (role === 'editor' || role === 'owner') && !access.isUploadHeld()))
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
      let member: WorkspaceRole | null
      try {
        member = await getLocalMemberRole(tx, workspaceId, repo.user.id)
      } catch (error) {
        console.error('Could not verify workspace membership', error)
        return {reason: 'Could not verify workspace membership', transient: false}
      }
      if (member === null) return {reason: 'Waiting for the local member row', transient: false}
      if (!admitted) {
        const stamp = db.currentStatus.lastSyncedAt?.getTime()
        if (stamp === undefined || stamp === baseline) {
          return {reason: 'Waiting for a checkpoint from this connection', transient: false}
        }
        const gap = await repo.workspaceViewGap(workspaceId, viewGapReadsOver(tx))
        if (gap) return gap
      }
      return {role: member}
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
  const offTables = db.onChange({onChange: wake}, {tables: ['workspace_members', 'blocks_synced_changes', 'blocks_synced']})
  wake()
  return {
    reason: () => reason,
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
