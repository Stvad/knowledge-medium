import { useQuery } from '@powersync/react'
import { MATERIALIZE_QUEUE_COUNT_SQL } from '@/data/internals/syncObserver/observer'

/** The queue mutates every drain window, so the count is watched throttled. */
const backlogThrottleMs = 1_000

/** The device's materialization backlog ({@link MATERIALIZE_QUEUE_COUNT_SQL}),
 *  live: staged changes not yet applied to `blocks`. */
export const useMaterializeBacklog = (): number => {
  const {data} = useQuery<{count: number}>(
    MATERIALIZE_QUEUE_COUNT_SQL,
    [],
    {reportFetching: false, throttleMs: backlogThrottleMs},
  )
  return Number(data[0]?.count ?? 0)
}
