import VideoTimeStamp from './VideoTimeStamp.tsx'
import type { MarkdownExtension } from '@/markdown/extensions.ts'
import { remarkTimestamps } from './remark-timestamps.ts'
import type { Components } from 'react-markdown'

interface TimestampNode {
  properties?: {
    hms?: unknown
  }
}

interface TimestampComponentProps {
  node?: TimestampNode
}

export const videoPlayerMarkdownExtension: MarkdownExtension = ({blockContext}) => {
  const videoBlockId = blockContext.videoPlayerBlockId
  if (typeof videoBlockId !== 'string') return null

  return {
    remarkPlugins: [remarkTimestamps],
    components: {
      'time-stamp': ({node}: TimestampComponentProps) => {
        const hms = node?.properties?.hms
        if (typeof hms !== 'string') return null

        return <VideoTimeStamp hms={hms} videoBlockId={videoBlockId}/>
      },
    } as unknown as Components,
  }
}
