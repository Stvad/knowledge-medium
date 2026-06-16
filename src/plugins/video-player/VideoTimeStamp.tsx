import { hmsToSeconds } from '@/utils/time.js'
import { seekTo } from './registry.ts'
import { SyntheticEvent } from 'react'

export interface TimeStampProps {
  hms: string;
  videoBlockId: string;
  /** Render scope of the note holding this link, so the seek targets the
   *  player in the same panel when the video is open in several. */
  renderScopeId?: string;
}

const VideoTimeStamp = ({hms, videoBlockId, renderScopeId}: TimeStampProps) => {
  const secs = hmsToSeconds(hms)

  const interactionHandler = (e: SyntheticEvent) => {
    e.stopPropagation()
    e.preventDefault()

    seekTo(secs, videoBlockId, renderScopeId)
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
