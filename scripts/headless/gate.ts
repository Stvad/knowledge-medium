import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {Repo} from '@/data/repo'
import {getLocalMemberRole} from '@/data/workspaces'
import type {WorkspaceRole} from '@/types'

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

  function cancelPreparation() {
    if (preparation instanceof AbortController) preparation.abort()
    preparation = undefined
    role = null
    applyWritability()
  }

  function close(message: string) {
    cancelPreparation()
    if (admitted) visibility(false)
    admitted = false
    reason = message
  }

  // A stalled namespace read must not block demotion, removal or shutdown.
  function startPreparation(nextRole: WorkspaceRole) {
    role = nextRole
    applyWritability()
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

  async function entryRefusal() {
    const stamp = db.currentStatus.lastSyncedAt?.getTime()
    if (stamp === undefined || stamp === baseline) return 'Waiting for a checkpoint from this connection'
    let gap = await repo.workspaceViewGap(workspaceId)
    if (gap?.transient) {
      reason = gap.reason
      await repo.flushSyncObserver()
      gap = await repo.workspaceViewGap(workspaceId)
    }
    return gap?.reason ?? null
  }

  async function refresh() {
    // Admission lasts for this membership. Read its role after a potentially
    // long drain so the permission used by bootstrap is current.
    const refusal = admitted || preparation instanceof AbortController ? null : await entryRefusal()
    let member: WorkspaceRole | null
    try {
      member = await getLocalMemberRole(repo, workspaceId, repo.user.id)
    } catch (error) {
      close('Could not verify workspace membership')
      console.error(reason, error)
      return
    }
    if (member === null) {
      close('Waiting for the local member row')
      return
    }
    if (refusal !== null) {
      close(refusal)
      return
    }
    if (role !== member) cancelPreparation()
    if (preparation instanceof AbortController) return
    if (stopped) return
    if (preparation === 'ready') {
      reason = null
      if (!admitted) visibility(true)
      admitted = true
    } else {
      startPreparation(member)
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
      cancelPreparation()
      await pending
    },
  }
}
