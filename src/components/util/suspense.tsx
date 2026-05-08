import { useEffect } from 'react'
import { recordFallbackShown } from '@/utils/suspenseDebug.ts'

interface SuspenseFallbackProps {
  /** When set, logs fallback show/hide transitions to the suspense
   *  tracer. Pass for top-level boundaries you want timing on; leave
   *  undefined for per-block fallbacks (which would be very noisy). */
  name?: string
}

export const SuspenseFallback = ({name}: SuspenseFallbackProps = {}) => {
  useEffect(() => {
    if (!name) return
    const handle = recordFallbackShown(name)
    return handle.hide
  }, [name])
  return <div>Loading...</div>
}
