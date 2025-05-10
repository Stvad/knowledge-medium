import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { useData } from '@/data/block.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'

const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  if (!blockData) return null

  return (
    <div className="aspect-video">
      <ReactPlayer
        url={blockData.content}
        controls
        width="100%"
        height="100%"
      />
    </div>
  )
}

export const VideoPlayerRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <DefaultBlockRenderer
    {...props}
    ContentRenderer={VideoPlayerContentRenderer}
  />

VideoPlayerRenderer.canRender = ({block}: BlockRendererProps) => {
  const blockData = block.dataSync()
  return !!(blockData && ReactPlayer.canPlay(blockData.content))
}

VideoPlayerRenderer.priority = () => 10
