/**
 * What an unlocking gate shows while it drains: the drain's own progress, and
 * the device's sync work it waits behind. The drain queues behind the
 * observer's other passes, so on a fresh device it can sit through much of the
 * initial sync before its first window.
 */

import { useQuery, useStatus } from '@powersync/react'
import { Loader2 } from 'lucide-react'
import {
  MATERIALIZE_QUEUE_COUNT_SQL,
  type RematerializeProgress,
} from '@/data/internals/syncObserver/observer'

/** Where a gate's drain is: queued behind this device's other sync work, or
 *  `done` of `total` staged rows in. */
export type DrainProgress =
  | {readonly kind: 'waiting'}
  | ({readonly kind: 'running'} & RematerializeProgress)

const backlogThrottleMs = 1_000

const percent = (fraction: number): string => `${Math.floor(fraction * 100)}%`

export function UnlockProgress({progress}: {progress: DrainProgress}) {
  const status = useStatus()
  const backlog = useQuery<{count: number}>(
    MATERIALIZE_QUEUE_COUNT_SQL,
    [],
    {reportFetching: false, throttleMs: backlogThrottleMs},
  )
  const applying = Number(backlog.data[0]?.count ?? 0)
  const downloadFraction = status.downloadProgress?.downloadedFraction ?? null

  return (
    <div role="status" className="space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin"/>
        A large workspace can take a few minutes.
      </p>
      {status.dataFlowStatus.downloading && (
        <ProgressRow
          label="Downloading from the server"
          detail={downloadFraction === null ? null : percent(downloadFraction)}
          fraction={downloadFraction}
        />
      )}
      {applying > 0 && (
        <ProgressRow label="Applying synced changes" detail={`${applying.toLocaleString()} left`}/>
      )}
      {progress.kind === 'waiting' ? (
        <ProgressRow label="Opening this workspace" detail="Waiting for sync"/>
      ) : (
        <ProgressRow
          label="Opening this workspace"
          detail={`${progress.done.toLocaleString()} of ${progress.total.toLocaleString()} blocks`}
          fraction={progress.total > 0 ? progress.done / progress.total : null}
        />
      )}
    </div>
  )
}

function ProgressRow({label, detail, fraction = null}: {label: string; detail: string | null; fraction?: number | null}) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-3">
        <span>{label}</span>
        {detail && <span className="shrink-0 tabular-nums text-muted-foreground">{detail}</span>}
      </div>
      {fraction !== null && (
        <div className="h-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width]" style={{width: percent(fraction)}}/>
        </div>
      )}
    </div>
  )
}
