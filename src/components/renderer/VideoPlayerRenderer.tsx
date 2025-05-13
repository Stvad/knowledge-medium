import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { useData } from '@/data/block.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'
import { useEffect, useRef } from 'react'
import { ActionContextType as OriginalActionContextType } from '@/shortcuts/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'

// Define the event type for seeking
interface SeekToEventDetail {
  seconds: number;
  blockId: string;
}

const seekToEventName = 'video-seek-to'
export const seekTo = (seconds: number, blockId: string) => {
  const event = new CustomEvent<SeekToEventDetail>(seekToEventName, {
    detail: {seconds, blockId},
  })
  window.dispatchEvent(event)
}

declare global {
  export type ActionContextType = OriginalActionContextType | 'last-video-player'
}

const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  const player = useRef<ReactPlayer>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handleSeekTo = (event: CustomEvent<SeekToEventDetail>) => {
      if (event.detail.blockId === block.id && player.current) {
        player.current.seekTo(event.detail.seconds)

        focusPlayer()
      }
    }

    window.addEventListener(seekToEventName, handleSeekTo as EventListener)

    return () => window.removeEventListener(seekToEventName, handleSeekTo as EventListener)
  }, [block.id])

  const focusPlayer = () => {
    if (containerRef.current) {
      containerRef.current.scrollTo()
      // containerRef.current.focus() // todo doesn't actually transfer controls to the player =\
    }
  }

  if (!blockData) return null

  return (
    <div ref={containerRef} className="aspect-video">
      <ReactPlayer
        ref={player}
        url={blockData.content}
        controls
        width="100%"
        height="100%"
      />
    </div>
  )
}

export const VideoPlayerRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <NestedBlockContextProvider overrides={{videoPlayerBlockId: props.block.id}}>
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={VideoPlayerContentRenderer}
    />
  </NestedBlockContextProvider>

VideoPlayerRenderer.canRender = ({block}: BlockRendererProps) =>
{
  const blockData = block.dataSync()
  return !!(blockData && ReactPlayer.canPlay(blockData.content))
}

VideoPlayerRenderer.priority = () => 10
