import { useQuery, useStatus } from '@powersync/react'
import {
  CircleAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  HardDrive,
  RefreshCw,
} from 'lucide-react'
import { useState } from 'react'
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
  const errorMessage =
    rejected.error?.message ??
    status.dataFlowStatus.uploadError?.message ??
    status.dataFlowStatus.downloadError?.message ??
    null

  if (localOnly) {
    return (
      <SyncStatusHeaderContent
        localOnly={localOnly}
        status={status}
        pendingChanges={0}
        pendingChangesApproximate={false}
        rejectedCount={rejectedCount}
        errorMessage={errorMessage}
      />
    )
  }

  return (
    <RemoteSyncStatusHeaderContent
      status={status}
      rejectedCount={rejectedCount}
      baseErrorMessage={errorMessage}
    />
  )
}

interface RemoteSyncStatusHeaderContentProps {
  status: SyncStatus
  rejectedCount: number
  baseErrorMessage: string | null
}

function RemoteSyncStatusHeaderContent({
  status,
  rejectedCount,
  baseErrorMessage,
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
      errorMessage={queue.error?.message ?? baseErrorMessage}
    />
  )
}

interface SyncStatusHeaderContentProps {
  localOnly: boolean
  status: SyncStatus
  pendingChanges: number
  pendingChangesApproximate: boolean
  rejectedCount: number
  errorMessage: string | null
}

function SyncStatusHeaderContent({
  localOnly,
  status,
  pendingChanges,
  pendingChangesApproximate,
  rejectedCount,
  errorMessage,
}: SyncStatusHeaderContentProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const dataFlow = status.dataFlowStatus
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
