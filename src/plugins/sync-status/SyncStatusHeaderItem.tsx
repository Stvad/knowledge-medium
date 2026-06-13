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
import { appVersion } from '@/appVersion.js'
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
  materializeQueueCountSql,
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
    // Cleanup runs whenever `message` changes (including back to null), so it
    // both cancels a not-yet-elapsed timer AND clears any previously-shown
    // value. Resetting here is what makes a *recurring* identical error
    // re-serve its full grace window instead of flashing instantly because
    // `stable` still held the old string. (Done in cleanup, not the effect
    // body, to avoid a synchronous in-effect setState.)
    return () => {
      clearTimeout(timer)
      setStable(null)
    }
  }, [message, delayMs])
  // `stable` only equals `message` once the timer has elapsed for the current
  // continuous error; a cleared message returns null immediately.
  return stable === message ? message : null
}

// Tracks the device's network reachability via `navigator.onLine` +
// online/offline events. We use this to decide whether a sync error is mere
// connectivity noise (device offline → show the calm "Offline" chip) or an
// actionable failure (device online but sync still failing → surface it).
function useIsDeviceOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
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

// The build the client is running. `display` is the committer-date version
// (e.g. "2026.06.13-1216"); the short SHA links to the exact commit. A local
// `dev` build (no `define` applied) collapses to a plain "dev".
function AppVersionValue() {
  const {display, sha, commitUrl} = appVersion
  if (sha === 'dev') return <span>{display}</span>
  const inner = (
    <>
      {display}
      <span className="text-muted-foreground"> · {sha}</span>
    </>
  )
  return commitUrl ? (
    <a
      href={commitUrl}
      target="_blank"
      rel="noreferrer"
      className="underline-offset-2 hover:underline"
      title={`Commit ${sha}`}
    >
      {inner}
    </a>
  ) : (
    <span title={`Commit ${sha}`}>{inner}</span>
  )
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
        materializingChanges={0}
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

  // Staged rows the Layout B observer hasn't applied to `blocks` yet. The change
  // queue mutates every drain window, so watch it throttled like the upload
  // preview; it counts down to 0 as the backlog materializes.
  const materializeQueue = useQuery<UploadQueueCountRow>(
    materializeQueueCountSql,
    [],
    {
      reportFetching: false,
      throttleMs: uploadQueuePreviewThrottleMs,
    },
  )
  const materializingChanges = Number(materializeQueue.data[0]?.count ?? 0)

  return (
    <SyncStatusHeaderContent
      localOnly={false}
      status={status}
      pendingChanges={pendingChanges}
      pendingChangesApproximate={pendingChangesApproximate}
      rejectedCount={rejectedCount}
      materializingChanges={materializingChanges}
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
  materializingChanges: number
  localErrorMessage: string | null
}

function SyncStatusHeaderContent({
  localOnly,
  status,
  pendingChanges,
  pendingChangesApproximate,
  rejectedCount,
  materializingChanges,
  localErrorMessage,
}: SyncStatusHeaderContentProps) {
  const [dialogOpen, setDialogOpen] = useState(false)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const deviceOnline = useIsDeviceOnline()
  const dataFlow = status.dataFlowStatus
  // Decide whether a sync error is worth showing. When the *device* is
  // offline, any upload/download error is just connectivity noise — show the
  // calm "Offline" chip, not a raw websocket/fetch error. But when the
  // device is online and sync still fails (bad PowerSync endpoint, 401/403
  // credentials, server-side stream failure), the error is actionable and
  // must surface even though PowerSync flips `connected: false` during its
  // retry loop — otherwise the chip is stuck on Offline/Connecting forever
  // and hides the very reason sync isn't working. The grace window below
  // still debounces transient blips in both cases.
  const networkError = deviceOnline
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
    materializingChanges,
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
              {materializingChanges > 0 && (
                <>
                  <div className="text-muted-foreground">Processing</div>
                  <div className="text-right">
                    {materializingChanges.toLocaleString()} {materializingChanges === 1 ? 'block' : 'blocks'}
                  </div>
                </>
              )}
              <div className="text-muted-foreground">Last sync</div>
              <div className="text-right">{formatLastSyncedAt(status.lastSyncedAt)}</div>
              <div className="text-muted-foreground">Version</div>
              <div className="text-right">
                <AppVersionValue/>
              </div>
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
