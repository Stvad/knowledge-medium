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
        'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border',
        toneClass[view.tone],
      )}
      role="status"
      aria-live="polite"
      aria-label={view.title}
      title={view.title}
    >
      <Icon className={cn('h-4 w-4', view.spinning && 'animate-spin')}/>
    </div>
  )
}
