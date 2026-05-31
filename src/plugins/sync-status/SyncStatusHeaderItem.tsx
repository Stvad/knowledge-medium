import { useQuery, useStatus } from '@powersync/react'
import {
  CircleAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  HardDrive,
  RefreshCw,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { useIsLocalOnly } from '@/components/Login.js'
import { Button } from '@/components/ui/button.js'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu.js'
import { cn } from '@/lib/utils.js'
import {
  getSyncIndicatorView,
  type SyncIndicatorIcon,
  type SyncIndicatorTone,
} from './model.ts'
import {
  formatPendingChanges,
  uploadQueueCountCap,
  uploadQueueExactCountSql,
  uploadQueuePreviewCountSql,
} from './queueCounts.ts'
import { RejectionDialog } from './RejectionDialog.tsx'

interface UploadQueueCountRow {
  count: number
}

const uploadQueuePreviewThrottleMs = 1_000
const rejectedCountSql = 'SELECT COUNT(*) AS count FROM ps_crud_rejected'

// Network sync errors are noisy: a dropped connection or a token refresh
// caught mid-flight surfaces an error for a second or two before PowerSync
// recovers on its own. Only treat a network error as worth showing once it
// has persisted continuously for this long; clear it immediately when it
// resolves. (Offline is handled separately — see `SyncStatusHeaderContent`.)
const networkErrorGraceMs = 5_000

// Debounce the *appearance* of an error: surface `message` only after it has
// stayed non-null for `delayMs`, and drop it the instant it clears. Keeps the
// indicator from flashing on transient blips.
function useStableError(message: string | null, delayMs: number): string | null {
  const [stable, setStable] = useState<string | null>(null)
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setStable(message), delayMs)
    return () => clearTimeout(timer)
  }, [message, delayMs])
  // Report the error only once the debounced value has caught up with the
  // current message — and report null immediately when the message clears.
  // Deriving this at render (rather than clearing `stable` via a setState in
  // the effect) keeps the indicator responsive and avoids a render cascade.
  return stable === message ? message : null
}

type SyncStatus = ReturnType<typeof useStatus>

// Theme-aware tones. `success` reads `--success` (per-theme green
// hue) rather than `--primary` so warm-primary palettes like
// sunset-warm don't paint the "synced OK" chip in alarming reds.
// `active` keeps the primary tint — a spinning icon plus primary
// hue communicates "in progress" without colliding with the
// "good/bad" semantic of success/error. `warning` is a softer
// destructive shade so a glance still differentiates "needs
// attention" from a hard error.
const toneClass: Record<SyncIndicatorTone, string> = {
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  warning: 'border-destructive/20 bg-destructive/5 text-destructive',
  active: 'border-primary/30 bg-primary/10 text-primary',
  success: 'border-success/30 bg-success/10 text-success',
  local: 'border-border bg-muted/50 text-muted-foreground',
  neutral: 'border-border bg-background text-muted-foreground',
}

const iconByName = {
  alert: CircleAlert,
  'hard-drive': HardDrive,
  upload: CloudUpload,
  sync: RefreshCw,
  offline: CloudOff,
  check: CloudCheck,
} satisfies Record<SyncIndicatorIcon, typeof CircleAlert>

const formatLastSyncedAt = (date: Date | undefined): string => {
  if (!date) return 'Not synced yet'
  return date.toLocaleString()
}

export function SyncStatusHeaderItem() {
  const localOnly = useIsLocalOnly()
  const status = useStatus()
  const rejected = useQuery<UploadQueueCountRow>(
    rejectedCountSql,
    [],
    {reportFetching: false},
  )
  const rejectedCount = Number(rejected.data[0]?.count ?? 0)
  // Local-query failures (counting the rejection quarantine) are real and
  // surfaced immediately. Network/sync errors are handled — and offline is
  // distinguished from a genuine error — down in SyncStatusHeaderContent.
  const localErrorMessage = rejected.error?.message ?? null

  if (localOnly) {
    return (
      <SyncStatusHeaderContent
        localOnly={localOnly}
        status={status}
        pendingChanges={0}
        pendingChangesApproximate={false}
        rejectedCount={rejectedCount}
        localErrorMessage={localErrorMessage}
      />
    )
  }

  return (
    <RemoteSyncStatusHeaderContent
      status={status}
      rejectedCount={rejectedCount}
      baseLocalErrorMessage={localErrorMessage}
    />
  )
}

interface RemoteSyncStatusHeaderContentProps {
  status: SyncStatus
  rejectedCount: number
  baseLocalErrorMessage: string | null
}

function RemoteSyncStatusHeaderContent({
  status,
  rejectedCount,
  baseLocalErrorMessage,
}: RemoteSyncStatusHeaderContentProps) {
  const queue = useQuery<UploadQueueCountRow>(
    uploadQueuePreviewCountSql,
    [],
    {
      reportFetching: false,
      throttleMs: uploadQueuePreviewThrottleMs,
    },
  )
  const previewCount = Number(queue.data[0]?.count ?? 0)
  const pendingChangesApproximate = previewCount > uploadQueueCountCap
  const pendingChanges = pendingChangesApproximate ? uploadQueueCountCap : previewCount

  return (
    <SyncStatusHeaderContent
      localOnly={false}
      status={status}
      pendingChanges={pendingChanges}
      pendingChangesApproximate={pendingChangesApproximate}
      rejectedCount={rejectedCount}
      localErrorMessage={queue.error?.message ?? baseLocalErrorMessage}
    />
  )
}

interface SyncStatusHeaderContentProps {
  localOnly: boolean
  status: SyncStatus
  pendingChanges: number
  pendingChangesApproximate: boolean
  rejectedCount: number
  localErrorMessage: string | null
}

function SyncStatusHeaderContent({
  localOnly,
  status,
  pendingChanges,
  pendingChangesApproximate,
  rejectedCount,
  localErrorMessage,
}: SyncStatusHeaderContentProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const dataFlow = status.dataFlowStatus
  // A connection error while we're not connected is just "we're offline" —
  // show the calm offline state, not a websocket error. Treat a sync error
  // as real only while we believe we're connected, and only once it has
  // outlived the transient-blip grace window.
  const networkError = status.connected
    ? (dataFlow.uploadError?.message ?? dataFlow.downloadError?.message ?? null)
    : null
  const stableNetworkError = useStableError(networkError, networkErrorGraceMs)
  const errorMessage = localErrorMessage ?? stableNetworkError
  const view = getSyncIndicatorView({
    localOnly,
    connected: status.connected,
    connecting: status.connecting,
    hasSynced: status.hasSynced,
    uploading: Boolean(dataFlow.uploading),
    downloading: Boolean(dataFlow.downloading),
    pendingChanges,
    pendingChangesApproximate,
    rejectedChanges: rejectedCount,
    downloadFraction: status.downloadProgress?.downloadedFraction ?? null,
    errorMessage,
    lastSyncedAt: status.lastSyncedAt,
  })
  const Icon = iconByName[view.icon]

  return (
    <>
      <DropdownMenu open={detailsOpen} onOpenChange={setDetailsOpen}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-md border outline-none transition-colors focus-visible:ring-1 focus-visible:ring-ring sm:h-8 sm:w-8',
              toneClass[view.tone],
            )}
            aria-label={view.title}
            title={view.title}
          >
            <Icon className={cn('h-4 w-4', view.spinning && 'animate-spin')}/>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 p-3">
          <div className="space-y-3">
            <div className="flex items-start gap-2">
              <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', view.spinning && 'animate-spin')}/>
              <div className="min-w-0">
                <div className="text-sm font-medium">{view.label}</div>
                <div className="text-xs leading-5 text-muted-foreground">{view.title}</div>
              </div>
            </div>
            <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
              <div className="text-muted-foreground">Unsynced</div>
              <div className="text-right">
                {detailsOpen ? (
                  <UploadQueueDetails
                    localOnly={localOnly}
                    previewCount={pendingChanges}
                    previewApproximate={pendingChangesApproximate}
                  />
                ) : (
                  formatPendingChanges(pendingChanges, localOnly, pendingChangesApproximate)
                )}
              </div>
              {view.progressPercent !== null && (
                <>
                  <div className="text-muted-foreground">Progress</div>
                  <div className="text-right">{view.progressPercent}%</div>
                </>
              )}
              <div className="text-muted-foreground">Last sync</div>
              <div className="text-right">{formatLastSyncedAt(status.lastSyncedAt)}</div>
            </div>
            {rejectedCount > 0 && (
              <div className="border-t pt-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-destructive">
                    {rejectedCount} {rejectedCount === 1 ? 'change' : 'changes'} couldn't sync
                  </div>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    onClick={() => setDialogOpen(true)}
                  >
                    View
                  </Button>
                </div>
              </div>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>
      <RejectionDialog open={dialogOpen} onOpenChange={setDialogOpen}/>
    </>
  )
}

interface UploadQueueDetailsProps {
  localOnly: boolean
  previewCount: number
  previewApproximate: boolean
}

function UploadQueueDetails({
  localOnly,
  previewCount,
  previewApproximate,
}: UploadQueueDetailsProps) {
  const queue = useQuery<UploadQueueCountRow>(
    uploadQueueExactCountSql,
    [],
    {
      reportFetching: false,
      runQueryOnce: true,
    },
  )
  const exactCount = queue.data[0]?.count

  if (queue.error) {
    return 'Unable to count unsynced changes'
  }

  if (exactCount === undefined) {
    return formatPendingChanges(previewCount, localOnly, previewApproximate)
  }

  return formatPendingChanges(Number(exactCount), localOnly)
}
