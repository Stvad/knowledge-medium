import type {CommonPowerSyncDatabase} from '@powersync/common'
import type {Repo} from '@/data/repo'
import {getLocalMemberRole} from '@/data/workspaces'

/** Membership loss ends this admission. A reconnect alone leaves already-admitted
 * offline reads available. Every new admission checks all workspaceViewGap arms. */
export const startReadGate = (
  db: CommonPowerSyncDatabase, repo: Repo, workspaceId: string, baseline: number | undefined,
  open: () => Promise<void>, visibility: (open: boolean) => void,
) => {
  let reason: string | null = 'Waiting for a checkpoint from this connection'
  let pending: Promise<void> | undefined
  let dirty = false
  let stopped = false

  function close(message: string) {
    if (reason === null) visibility(false)
    reason = message
  }

  async function check() {
    const stamp = db.currentStatus.lastSyncedAt?.getTime()
    if (stamp === undefined || stamp === baseline) return close('Waiting for a checkpoint from this connection')
    if (await getLocalMemberRole(repo, workspaceId, repo.user.id) === null) return close('Waiting for the local member row')
    if (reason === null) return
    let gap = await repo.workspaceViewGap(workspaceId)
    if (gap?.transient) {
      close(gap.reason)
      await repo.flushSyncObserver()
      gap = await repo.workspaceViewGap(workspaceId)
    }
    if (gap) return close(gap.reason)
    await open()
    if (!stopped) {
      reason = null
      visibility(true)
    }
  }
  // Coalesce status and table notifications during a drain into one fresh read.
  function refresh(): Promise<void> {
    dirty = true
    pending ??= (async () => {
      while (dirty && !stopped) {
        dirty = false
        await check()
      }
    })().finally(() => { pending = undefined })
    return pending
  }
  function wake() {
    void refresh().catch(() => close('Failed to check the workspace or open its data'))
  }
  const offStatus = db.registerListener({statusChanged: wake})
  const offTables = repo.db.onChange({onChange: wake}, {tables: ['workspace_members', 'blocks_synced_changes', 'blocks_synced']})
  wake()
  return {
    reason: () => reason,
    refresh: () => pending ?? refresh(),
    async stop() {
      stopped = true
      offTables()
      offStatus()
      await pending
    },
  }
}
