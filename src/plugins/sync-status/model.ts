export type SyncIndicatorState =
  | 'error'
  | 'local'
  | 'uploading'
  | 'downloading'
  | 'pending'
  | 'connecting'
  | 'offline'
  | 'synced'
  | 'starting'

export type SyncIndicatorTone = 'error' | 'local' | 'active' | 'warning' | 'success' | 'neutral'

export type SyncIndicatorIcon = 'alert' | 'hard-drive' | 'upload' | 'sync' | 'offline' | 'check'

export interface SyncIndicatorInput {
  localOnly: boolean
  connected: boolean
  connecting: boolean
  hasSynced?: boolean
  uploading: boolean
  downloading: boolean
  pendingChanges: number
  downloadFraction?: number | null
  errorMessage?: string | null
  lastSyncedAt?: Date
}

export interface SyncIndicatorView {
  state: SyncIndicatorState
  tone: SyncIndicatorTone
  icon: SyncIndicatorIcon
  label: string
  title: string
  pendingLabel: string | null
  progressPercent: number | null
  spinning: boolean
}

const formatPendingLabel = (count: number): string | null => {
  if (count <= 0) return null
  if (count > 999) return '999+'
  return String(count)
}

const formatChangeCount = (count: number): string => {
  if (count === 1) return '1 local change'
  return `${count} local changes`
}

const clampProgressPercent = (fraction: number | null | undefined): number | null => {
  if (fraction === null || fraction === undefined || !Number.isFinite(fraction)) return null
  return Math.round(Math.max(0, Math.min(1, fraction)) * 100)
}

const formatLastSyncedAt = (date: Date | undefined): string | null => {
  if (!date) return null
  return `Last synced ${date.toLocaleString()}.`
}

const appendPendingTitle = (title: string, pendingChanges: number, localOnly = false): string => {
  if (pendingChanges <= 0) return title
  const suffix = localOnly
    ? `${formatChangeCount(pendingChanges)} stored locally.`
    : `${formatChangeCount(pendingChanges)} queued for upload.`
  return `${title} ${suffix}`
}

export const getSyncIndicatorView = ({
  localOnly,
  connected,
  connecting,
  hasSynced,
  uploading,
  downloading,
  pendingChanges,
  downloadFraction,
  errorMessage,
  lastSyncedAt,
}: SyncIndicatorInput): SyncIndicatorView => {
  const progressPercent = clampProgressPercent(downloadFraction)
  const pendingLabel = formatPendingLabel(pendingChanges)

  if (localOnly) {
    return {
      state: 'local',
      tone: 'local',
      icon: 'hard-drive',
      label: 'Local only',
      title: appendPendingTitle('Remote sync is disabled.', pendingChanges, true),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (errorMessage) {
    return {
      state: 'error',
      tone: 'error',
      icon: 'alert',
      label: 'Sync issue',
      title: appendPendingTitle(`Sync needs attention: ${errorMessage}`, pendingChanges),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (downloading) {
    return {
      state: 'downloading',
      tone: 'active',
      icon: 'sync',
      label: progressPercent === null ? 'Syncing' : `Sync ${progressPercent}%`,
      title: appendPendingTitle(
        progressPercent === null
          ? 'Downloading remote changes.'
          : `Downloading remote changes: ${progressPercent}%.`,
        pendingChanges,
      ),
      pendingLabel,
      progressPercent,
      spinning: true,
    }
  }

  if (uploading) {
    return {
      state: 'uploading',
      tone: 'active',
      icon: 'sync',
      label: 'Uploading',
      title: appendPendingTitle('Uploading local changes.', pendingChanges),
      pendingLabel,
      progressPercent: null,
      spinning: true,
    }
  }

  if (pendingChanges > 0) {
    return {
      state: 'pending',
      tone: connected ? 'warning' : 'neutral',
      icon: 'upload',
      label: 'Pending',
      title: appendPendingTitle(
        connected ? 'Waiting to upload.' : 'Waiting for a sync connection.',
        pendingChanges,
      ),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (connecting) {
    return {
      state: 'connecting',
      tone: 'active',
      icon: 'sync',
      label: 'Connecting',
      title: 'Connecting to sync.',
      pendingLabel,
      progressPercent: null,
      spinning: true,
    }
  }

  if (!connected) {
    return {
      state: 'offline',
      tone: 'neutral',
      icon: 'offline',
      label: 'Offline',
      title: 'Sync is offline.',
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (hasSynced) {
    return {
      state: 'synced',
      tone: 'success',
      icon: 'check',
      label: 'Synced',
      title: formatLastSyncedAt(lastSyncedAt) ?? 'All local changes are synced.',
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  return {
    state: 'starting',
    tone: 'active',
    icon: 'sync',
    label: 'Starting',
    title: 'Preparing initial sync.',
    pendingLabel,
    progressPercent: null,
    spinning: true,
  }
}
