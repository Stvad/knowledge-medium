import { useSyncExternalStore } from 'react'
import {
  getStartupDbFileBytes,
  onStartupDbFileBytes,
  writeAheadSidecarBytes,
} from '@/utils/startupTimeline.js'
import { SuspenseFallback } from './suspense.tsx'

/** The open re-reads the whole write-ahead log, at about 7 ms per MB; below this
 *  it costs a couple of seconds, which the open's own variance already hides. */
const NOTICEABLE_LOG_BYTES = 256 * 1024 * 1024

const GB = 1024 ** 3

/** What the app shows while the local database opens: a plain "Loading", or, when
 *  the last session left a large log to replay, what the wait is for — a long
 *  open with nothing said reads as a hang. */
export const BootFallback = () => {
  const logBytes = writeAheadSidecarBytes(useSyncExternalStore(onStartupDbFileBytes, getStartupDbFileBytes))
  if (logBytes < NOTICEABLE_LOG_BYTES) return <SuspenseFallback/>
  const size = logBytes >= GB
    ? `${(logBytes / GB).toFixed(1)} GB`
    : `${Math.round(logBytes / (1024 * 1024))} MB`
  return <div>Loading... applying {size} of pending database changes from the last session. This can take a while.</div>
}
