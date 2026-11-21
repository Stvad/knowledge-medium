import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {Repo} from '@/data/repo'
import {getLocalMemberRole} from '@/data/workspaces'

export const startReadGate = (
  db: CommonPowerSyncDatabase, repo: Repo, workspaceId: string, baseline: number | undefined,
  open: (signal: AbortSignal) => Promise<void>, visibility: (open: boolean) => void,
) => {
  let reason: string | null = 'Checking workspace access'
  let preparation: AbortController | 'ready' | undefined
  let pending: Promise<void> | undefined
  let dirty = false
  let stopped = false

  function cancelPreparation() {
    if (preparation instanceof AbortController) preparation.abort()
    preparation = undefined
  }

  async function membershipRefusal(): Promise<string | null> {
    try {
      if (await getLocalMemberRole(repo, workspaceId, repo.user.id) === null) {
        cancelPreparation()
        if (reason === null) visibility(false)
        reason = 'Waiting for the local member row'
        return reason
      }
      return null
    } catch (error) {
      console.error('Could not verify workspace membership', error)
      return 'Could not verify workspace membership'
    }
  }

  // The membership subscription must stay responsive even if a projector
  // never primes. A completed preparation wakes the same entry checks again.
  function startPreparation() {
    const attempt = new AbortController()
    preparation = attempt
    reason = 'Opening workspace data'
    void open(attempt.signal).then(() => {
      if (attempt.signal.aborted) return
      preparation = 'ready'
      wake()
    }, error => {
      if (attempt.signal.aborted) return
      preparation = undefined
      reason = 'Could not open workspace data'
      console.error(reason, error)
    })
  }

  async function refresh() {
    const refusal = await membershipRefusal()
    if (refusal) {
      if (reason !== null) reason = refusal
      return
    }
    // Entry checks run once per membership. Ordinary downloads must preserve
    // watcher registrations and the already-open workspace data.
    if (reason === null || preparation instanceof AbortController) return
    const stamp = db.currentStatus.lastSyncedAt?.getTime()
    if (stamp === undefined || stamp === baseline) {
      reason = 'Waiting for a checkpoint from this connection'
      return
    }
    let gap = await repo.workspaceViewGap(workspaceId)
    if (gap?.transient) {
      reason = gap.reason
      await repo.flushSyncObserver()
      gap = await repo.workspaceViewGap(workspaceId)
    }
    if (gap) {
      reason = gap.reason
      return
    }
    if (stopped) return
    if (preparation === 'ready') {
      reason = null
      visibility(true)
    } else {
      startPreparation()
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
        reason = 'Could not check the workspace view'
        console.error(reason, error)
      } finally {
        pending = undefined
      }
    })()
  }
  const offStatus = db.registerListener({statusChanged: wake})
  const offTables = db.onChange({onChange: wake}, {tables: ['workspace_members', 'blocks_synced_changes', 'blocks_synced']})
  wake()
  return {
    reason: () => reason,
    async readReason() {
      if (reason !== null) {
        if (!pending) wake()
        return reason
      }
      // A command may arrive before the membership table notification.
      return await membershipRefusal() ?? reason
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
