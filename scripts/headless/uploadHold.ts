import type {CommonPowerSyncDatabase} from '@powersync/common'
import {UploadHeldError} from '@/services/powersync'

const WEEK_MS = 7 * 24 * 60 * 60 * 1000
export const STALE_QUEUE_REASON = 'Stale upload queue. Downloads can reach the oplog, but checkpoints cannot apply until the queue drains.'

export async function readUploadQueue(db: CommonPowerSyncDatabase, releasedThrough = 0) {
  const {queuedEntries, oldest, lastId} = await db.get<{queuedEntries: number, oldest: number | null, lastId: number}>(
    `SELECT count(*) AS queuedEntries, min(json_extract(data, '$.data.updated_at')) AS oldest,
            coalesce(max(id), 0) AS lastId FROM ps_crud WHERE id > ?`, [releasedThrough],
  )
  return {queuedEntries, oldestQueuedAgeMs: oldest === null ? null : Date.now() - oldest, lastId}
}

const staleQueue = (age: number | null) => (age ?? 0) > WEEK_MS

export function staleUploadHold(
  db: CommonPowerSyncDatabase, workspaceId: string, queue: Awaited<ReturnType<typeof readUploadQueue>>,
  release: boolean, onChange: () => void,
) {
  const staleAtBoot = staleQueue(queue.oldestQueuedAgeMs)
  // ps_crud ids increase across drains. Release only the queue the operator restarted with.
  const releasedThrough = release && staleAtBoot ? queue.lastId : 0
  let held = staleAtBoot && !release
  return {
    isHeld: () => held,
    async beforeUploadBatch() {
      const {oldestQueuedAgeMs} = await readUploadQueue(db, releasedThrough)
      held = staleQueue(oldestQueuedAgeMs)
      onChange()
      if (held) throw new UploadHeldError(workspaceId, STALE_QUEUE_REASON)
    },
  }
}
