/**
 * What a gate shows while it waits on this device's sync: the download, the
 * apply backlog, and why neither is moving. The gate's own work goes in as
 * `children`, one more row.
 *
 * No "N of M" for the backlog: its peak moves while the download feeds it.
 */

import type { ReactNode } from 'react'
import { useStatus } from '@powersync/react'
import { Loader2 } from 'lucide-react'
import { useMaterializeBacklog } from '@/hooks/useMaterializeBacklog'

/** Floored, so a nearly finished download never reads 100%; capped, since
 *  PowerSync's fraction can pass 1 after a compaction. */
const percent = (fraction: number): string => `${Math.floor(Math.min(fraction, 1) * 100)}%`

export function SyncProgress({children}: {children?: ReactNode}) {
  const status = useStatus()
  const applying = useMaterializeBacklog()
  const downloadFraction = status.downloadProgress?.downloadedFraction ?? null

  return (
    <div role="status" className="space-y-3 rounded-md border bg-muted/40 p-3 text-sm">
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin"/>
        A large workspace can take a few minutes.
      </p>
      {status.downloading && (
        <ProgressRow
          label="Downloading from the server"
          detail={downloadFraction === null ? null : percent(downloadFraction)}
          fraction={downloadFraction}
        />
      )}
      {status.downloadError ? (
        <ProgressRow label={`Download failed, retrying: ${status.downloadError.message}`} detail={null}/>
      ) : status.connected === false && !status.connecting && (
        <ProgressRow label="Offline" detail="Waiting for a connection"/>
      )}
      {applying > 0 && (
        <ProgressRow label="Applying synced changes" detail={`${applying.toLocaleString()} left`}/>
      )}
      {children}
    </div>
  )
}

export function ProgressRow({label, detail, fraction = null}: {label: string; detail: string | null; fraction?: number | null}) {
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
