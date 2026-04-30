import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { useEffect, useRef, useState } from 'react'
import { ActionContextType as OriginalActionContextType } from '@/shortcuts/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useData } from '@/hooks/block.ts'
import { seekToEventName, SeekToEventDetail } from './events.ts'

declare global {
  export type ActionContextType = OriginalActionContextType | 'last-video-player'
}

const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  const player = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)

  const focusPlayer = () => {
    if (containerRef.current) {
      containerRef.current.scrollTo()
      // containerRef.current.focus() // todo doesn't actually transfer controls to the player =\
    }
  }

  useEffect(() => {
    const handleSeekTo = (event: CustomEvent<SeekToEventDetail>) => {
      if (event.detail.blockId === block.id && player.current) {
        player.current.currentTime = event.detail.seconds

        focusPlayer()
        setIsPlaying(true)
      }
    }

    window.addEventListener(seekToEventName, handleSeekTo as EventListener)

    return () => window.removeEventListener(seekToEventName, handleSeekTo as EventListener)
  }, [block.id])

  if (!blockData) return null

  return (
    <div ref={containerRef} className="aspect-video">
      <ReactPlayer
        ref={player}
        src={blockData.content}
        playing={isPlaying}
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
  const blockData = block.peek()
  return !!(blockData && ReactPlayer.canPlay?.(blockData.content))
}

VideoPlayerRenderer.priority = () => 5
