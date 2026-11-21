import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {Repo, ViewGap} from '@/data/repo'
import {getLocalMemberRole} from '@/data/workspaces'

export const startReadGate = (
  db: CommonPowerSyncDatabase, repo: Repo, workspaceId: string, baseline: number | undefined,
  open: () => Promise<void>, visibility: (open: boolean) => void,
) => {
  const awaitingCheckpoint = 'Waiting for a checkpoint from this connection'
  let reason: string | null = 'Checking workspace access'
  let pending: Promise<void> | undefined
  let dirty = false
  let stopped = false

  function close(message: string) {
    if (reason === null) visibility(false)
    reason = message
  }

  // Only a workspace already admitted may keep serving offline. Its local gap
  // still matters: one table notification can cover a removal and rejoin.
  async function impediment(): Promise<ViewGap | null> {
    const stamp = db.currentStatus.lastSyncedAt?.getTime()
    if (stamp === undefined || stamp === baseline) return {reason: awaitingCheckpoint, transient: false}
    if (await getLocalMemberRole(repo, workspaceId, repo.user.id) === null) {
      return {reason: 'Waiting for the local member row', transient: false}
    }
    const arms = reason === null && !db.currentStatus.connected ? 'local' : 'all'
    return repo.workspaceViewGap(workspaceId, undefined, arms)
  }

  async function refresh() {
    let gap = await impediment()
    if (gap?.transient) {
      close(gap.reason)
      await repo.flushSyncObserver()
      gap = await impediment()
    }
    if (gap) return close(gap.reason)
    if (reason === null) return
    close('Opening workspace data')
    await open()
    // Membership and sync can change while loading definitions and namespaces.
    gap = await impediment()
    if (gap) return close(gap.reason)
    if (!stopped) {
      reason = null
      visibility(true)
    }
  }

  // There is one bootstrap/drain at a time. Notifications it overlaps require
  // one fresh check regardless of how many rows arrived.
  function wake() {
    dirty = true
    pending ??= (async () => {
      try {
        while (dirty && !stopped) {
          dirty = false
          await refresh()
        }
      } catch (error) {
        close(error instanceof Error ? error.message : 'Workspace check failed')
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
      // A request made while closed must not wait out a drain and then execute.
      // Recheck an open gate because table notifications are asynchronous.
      if (reason !== null) {
        if (!pending) wake()
        return reason
      }
      const gap = await impediment()
      if (gap) {
        close(gap.reason)
        wake()
      }
      return reason
    },
    async stop() {
      stopped = true
      offTables()
      offStatus()
      await pending
    },
  }
}
