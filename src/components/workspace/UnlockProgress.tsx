/**
 * What an unlocking gate shows while it drains: the device's sync work, and the
 * drain's own progress. The drain queues behind the observer's other passes, so
 * on a fresh device it can sit through much of the initial sync before its
 * first window.
 */

import type { RematerializeProgress } from '@/data/internals/syncObserver/observer'
import { ProgressRow, SyncProgress } from '@/components/workspace/SyncProgress'

/** Where a gate's drain is: queued behind this device's other sync work, or
 *  `done` of `total` staged rows in. */
export type DrainProgress =
  | {readonly kind: 'waiting'}
  | ({readonly kind: 'running'} & RematerializeProgress)

export function UnlockProgress({progress}: {progress: DrainProgress}) {
  return (
    <SyncProgress>
      {progress.kind === 'waiting' ? (
        <ProgressRow label="Opening this workspace" detail="Waiting for other sync work"/>
      ) : (
        <ProgressRow
          label="Opening this workspace"
          detail={`${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`}
          fraction={progress.total > 0 ? progress.done / progress.total : null}
        />
      )}
    </SyncProgress>
  )
}
