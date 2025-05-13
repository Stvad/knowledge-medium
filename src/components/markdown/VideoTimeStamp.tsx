import { hmsToSeconds } from '@/utils/time.ts'
import { seekTo } from '@/components/renderer/VideoPlayerRenderer.tsx'
import { SyntheticEvent } from 'react'

export interface TimeStampProps {
  hms: string;
  videoBlockId: string;
}

const VideoTimeStamp = ({hms, videoBlockId}: TimeStampProps) => {
  const secs = hmsToSeconds(hms)

  const interactionHandler = (e: SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()

    seekTo(secs, videoBlockId)
  }

  return (
    <a
      onClick={interactionHandler}
      onTouchStart={interactionHandler}
      data-seconds={secs}
      className={'cursor-pointer'}
    >
      <time dateTime={`PT${secs}S`}>{hms}</time>
    </a>
  )
}

export default VideoTimeStamp
