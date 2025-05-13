import { hmsToSeconds } from '@/utils/time.ts'
import { seekTo } from '@/components/renderer/VideoPlayerRenderer.tsx'

export interface TimeStampProps {
  hms: string;
  videoBlockId: string;
}

const VideoTimeStamp = ({hms, videoBlockId}: TimeStampProps) => {
  const secs = hmsToSeconds(hms)
  return (
    <a
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()

        seekTo(secs, videoBlockId)
      }}
      data-seconds={secs}
      className={'cursor-pointer'}
    >
      <time dateTime={`PT${secs}S`}>{hms}</time>
    </a>
  )
}

export default VideoTimeStamp
