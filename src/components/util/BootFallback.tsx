import { useSyncExternalStore } from 'react'
import {
  getStartupDbFileBytes,
  onStartupDbFileBytes,
  writeAheadSidecarBytes,
} from '@/utils/startupTimeline.js'
import { NOTICEABLE_LOG_BYTES } from '@/data/writeAheadLog.js'
import { localDbBuildGate } from '@/data/localDbBuildGate.js'
import { formatBytes } from '@/utils/formatBytes.js'
import { SuspenseFallback } from './suspense.tsx'

/** What the app shows while the local database opens: a plain "Loading", or,
 *  when the wait is for something the user can see or act on, what it is for —
 *  a long open with nothing said reads as a hang. */
export const BootFallback = () => {
  const logBytes = writeAheadSidecarBytes(useSyncExternalStore(onStartupDbFileBytes, getStartupDbFileBytes))
  const waitingForOtherBuild = useSyncExternalStore(localDbBuildGate.subscribe, localDbBuildGate.isWaiting)
  if (waitingForOtherBuild) {
    return <div>Loading... another tab is still on the previous version of the app. Reload or close it to continue here.</div>
  }
  if (logBytes < NOTICEABLE_LOG_BYTES) return <SuspenseFallback/>
  return <div>Loading... applying {formatBytes(logBytes)} of pending database changes from the last session. This can take a while.</div>
}
