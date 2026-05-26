import { useEffect } from 'react'
import { installDateScrubAuxListeners } from './dateScrubGesture.ts'

export const DateKeyboardScrubController = () => {
  useEffect(() => installDateScrubAuxListeners(), [])
  return null
}
