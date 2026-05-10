import { useQuery, useStatus } from '@powersync/react'
import {
  CircleAlert,
  CloudCheck,
  CloudOff,
  CloudUpload,
  HardDrive,
  RefreshCw,
} from 'lucide-react'
import { useIsLocalOnly } from '@/components/Login.tsx'
import { cn } from '@/lib/utils.ts'
import {
  getSyncIndicatorView,
  type SyncIndicatorIcon,
  type SyncIndicatorTone,
} from './model.ts'

interface UploadQueueCountRow {
  count: number
}

const toneClass: Record<SyncIndicatorTone, string> = {
  error: 'border-destructive/30 bg-destructive/10 text-destructive',
  local: 'border-border bg-muted/50 text-muted-foreground',
  active: 'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-900/60 dark:bg-blue-950/30 dark:text-blue-300',
  warning: 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-300',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/30 dark:text-emerald-300',
  neutral: 'border-border bg-background text-muted-foreground',
}

const badgeClass: Record<SyncIndicatorTone, string> = {
  error: 'bg-destructive text-destructive-foreground',
  local: 'bg-muted-foreground/15 text-foreground',
  active: 'bg-blue-600 text-white dark:bg-blue-500',
  warning: 'bg-amber-600 text-white dark:bg-amber-500',
  success: 'bg-emerald-600 text-white dark:bg-emerald-500',
  neutral: 'bg-muted-foreground/15 text-foreground',
}

const iconByName = {
  alert: CircleAlert,
  'hard-drive': HardDrive,
  upload: CloudUpload,
  sync: RefreshCw,
  offline: CloudOff,
  check: CloudCheck,
} satisfies Record<SyncIndicatorIcon, typeof CircleAlert>

export function SyncStatusHeaderItem() {
  const localOnly = useIsLocalOnly()
  const status = useStatus()
  const queue = useQuery<UploadQueueCountRow>(
    'SELECT COUNT(*) AS count FROM ps_crud',
    [],
    {reportFetching: false},
  )
  const pendingChanges = Number(queue.data[0]?.count ?? 0)
  const dataFlow = status.dataFlowStatus
  const errorMessage =
    queue.error?.message ??
    dataFlow.uploadError?.message ??
    dataFlow.downloadError?.message ??
    null
  const view = getSyncIndicatorView({
    localOnly,
    connected: status.connected,
    connecting: status.connecting,
    hasSynced: status.hasSynced,
    uploading: Boolean(dataFlow.uploading),
    downloading: Boolean(dataFlow.downloading),
    pendingChanges,
    downloadFraction: status.downloadProgress?.downloadedFraction ?? null,
    errorMessage,
    lastSyncedAt: status.lastSyncedAt,
  })
  const Icon = iconByName[view.icon]

  return (
    <div
      className={cn(
        'relative flex h-8 max-w-full items-center gap-1.5 overflow-hidden rounded-md border px-2 text-xs font-medium',
        toneClass[view.tone],
      )}
      role="status"
      aria-live="polite"
      aria-label={view.title}
      title={view.title}
    >
      <Icon className={cn('h-3.5 w-3.5 shrink-0', view.spinning && 'animate-spin')}/>
      <span className="hidden max-w-24 truncate sm:inline">{view.label}</span>
      {view.pendingLabel && (
        <span
          className={cn(
            'min-w-5 rounded px-1.5 py-0.5 text-center text-[10px] font-semibold leading-none',
            badgeClass[view.tone],
          )}
        >
          {view.pendingLabel}
        </span>
      )}
      {view.progressPercent !== null && (
        <span className="hidden h-1 w-10 overflow-hidden rounded bg-current/20 sm:block">
          <span
            className="block h-full rounded bg-current"
            style={{width: `${view.progressPercent}%`}}
          />
        </span>
      )}
    </div>
  )
}
