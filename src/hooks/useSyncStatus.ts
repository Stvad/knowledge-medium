import { useEffect, useState } from 'react'
import { useRepo } from '@/context/repo'
import { useDbQuery } from './useDbQuery'
import {
  getElectricSyncState,
  subscribeElectricSyncState,
} from '@/services/sync/electricSyncState'

interface UploadQueueCountRow {
  count: number
}

export const useSyncStatus = () => {
  const repo = useRepo()
  const queue = useDbQuery<UploadQueueCountRow>(
    'SELECT COUNT(*) AS count FROM outbox',
  )
  const [syncState, setSyncState] = useState(() => getElectricSyncState(repo.user.id))

  useEffect(() => subscribeElectricSyncState(() => {
    setSyncState(getElectricSyncState(repo.user.id))
  }), [repo.user.id])

  return {
    ...syncState,
    pendingChanges: Number(queue.data[0]?.count ?? 0),
    errorMessage: queue.error?.message ?? syncState.errorMessage,
  }
}
