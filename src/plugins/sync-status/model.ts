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
  /** Count of rows in `ps_crud_rejected` — writes the server permanently
   *  refused (FK, RLS, 4xx). Sync may still be working for new writes;
   *  these are unfinished business that needs manual retry or dismissal.
   *  Defaults to 0 so callers that don't pipe it in stay backwards-
   *  compatible. */
  rejectedChanges?: number
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

const formatRejectedCount = (count: number): string => {
  if (count === 1) return "1 change couldn't sync — review."
  return `${count} changes couldn't sync — review.`
}

const appendRejectedTitle = (title: string, rejectedChanges: number): string => {
  if (rejectedChanges <= 0) return title
  return `${title} ${formatRejectedCount(rejectedChanges)}`
}

export const getSyncIndicatorView = ({
  localOnly,
  connected,
  connecting,
  hasSynced,
  uploading,
  downloading,
  pendingChanges,
  rejectedChanges = 0,
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
      title: appendRejectedTitle('Sync is offline.', rejectedChanges),
      pendingLabel,
      progressPercent: null,
      spinning: false,
    }
  }

  if (hasSynced) {
    // The bucket is drained, but if some earlier writes are sitting in
    // the rejection quarantine, sync isn't fully "OK" from the user's
    // perspective. Keep state='synced' (new writes do land) but make
    // the chip visually distinct so it surfaces in passing.
    if (rejectedChanges > 0) {
      return {
        state: 'synced',
        tone: 'warning',
        icon: 'alert',
        label: 'Synced with issues',
        title: appendRejectedTitle(
          formatLastSyncedAt(lastSyncedAt) ?? 'All current changes are synced.',
          rejectedChanges,
        ),
        pendingLabel,
        progressPercent: null,
        spinning: false,
      }
    }
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
