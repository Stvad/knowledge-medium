import { useSyncExternalStore } from 'react'
import {
  getStartupDbFileBytes,
  onStartupDbFileBytes,
  writeAheadSidecarBytes,
} from '@/utils/startupTimeline.js'
import { NOTICEABLE_LOG_BYTES } from '@/data/writeAheadLog.js'
import { formatBytes } from '@/utils/formatBytes.js'
import { SuspenseFallback } from './suspense.tsx'

/** What the app shows while the local database opens: a plain "Loading", or, when
 *  the last session left a large log to replay, what the wait is for — a long
 *  open with nothing said reads as a hang. */
export const BootFallback = () => {
  const logBytes = writeAheadSidecarBytes(useSyncExternalStore(onStartupDbFileBytes, getStartupDbFileBytes))
  if (logBytes < NOTICEABLE_LOG_BYTES) return <SuspenseFallback/>
  return <div>Loading... applying {formatBytes(logBytes)} of pending database changes from the last session. This can take a while.</div>
}
