import VideoTimeStamp from '@/components/markdown/VideoTimeStamp.tsx'
import { markdownExtensionsFacet } from '@/markdown/extensions.ts'
import type { MarkdownExtension } from '@/markdown/extensions.ts'
import { remarkTimestamps } from '@/markdown/remark-timestamps.ts'
import type { Components } from 'react-markdown'

interface TimestampNode {
  properties?: {
    hms?: unknown
  }
}

interface TimestampComponentProps {
  node?: TimestampNode
}

export const videoPlayerMarkdownExtension: MarkdownExtension = {
  id: 'video-player.timestamps',
  appliesTo: ({blockContext}) =>
    typeof blockContext.videoPlayerBlockId === 'string',
  remarkPlugins: [remarkTimestamps],
  components: ({blockContext}) => {
    const videoBlockId = blockContext.videoPlayerBlockId
    if (typeof videoBlockId !== 'string') return {}

    return {
      'time-stamp': ({node}: TimestampComponentProps) => {
        const hms = node?.properties?.hms
        if (typeof hms !== 'string') return null

        return <VideoTimeStamp hms={hms} videoBlockId={videoBlockId}/>
      },
    } as unknown as Components
  },
}

export const videoPlayerMarkdownExtensionContribution = markdownExtensionsFacet.of(
  videoPlayerMarkdownExtension,
  {source: 'videoPlayer'},
)
