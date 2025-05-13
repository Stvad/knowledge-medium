import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { useData } from '@/data/block.ts'
import { DefaultBlockRenderer } from './DefaultBlockRenderer.tsx'
import { useEffect, useRef } from 'react'
import { useCommandPaletteShortcuts, useActionContext } from '@/shortcuts/useActionContext.ts'
import { ActionContextType as OriginalActionContextType, ActionContextConfig } from '@/shortcuts/types.ts'
import { actionManager } from '@/shortcuts/ActionManager.ts'
import { useUIStateProperty } from '@/data/globalState.ts'
import { focusedBlockIdProp } from '@/data/properties.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'

// Define the event type for seeking
interface SeekToEventDetail {
  seconds: number;
  blockId: string;
}

// Function to emit the 'video-seek-to' event
const seekToEventName = 'video-seek-to'
export const seekTo = (seconds: number, blockId: string) => {
  const event = new CustomEvent<SeekToEventDetail>(seekToEventName, {
    detail: {seconds, blockId},
  })
  window.dispatchEvent(event)
}

const lastVideoPlayerContext: ActionContextConfig = {
  type: 'last-video-player',
  displayName: 'Last Video',
  validateDependencies(deps: unknown) {
    return deps && 'player' in deps
  },
}

declare global {
  export type ActionContextType = OriginalActionContextType | 'last-video-player'
}

const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  const player = useRef<ReactPlayer>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  // const [,setFocusedBlockId] = useUIStateProperty(focusedBlockIdProp)

  useEffect(() => {
    actionManager.registerContext(lastVideoPlayerContext)
    actionManager.registerAction({
      context: lastVideoPlayerContext.type,
      description: 'Seek to 60',
      id: 'last-video-play-pause',
      handler({player}: { player: ReactPlayer }) {
        player.seekTo(60)
        // player.
      },
    })

  })
  // how does this behave with multiple players?
  // last rendered player gets interactions, need to be last-actioned player 🤔
  useActionContext('last-video-player', {player: player.current})

  useEffect(() => {
    const handleSeekTo = (event: CustomEvent<SeekToEventDetail>) => {
      if (event.detail.blockId === block.id && player.current) {
        // setFocusedBlockId(block.id)
        player.current.seekTo(event.detail.seconds)
        // player.current.getInternalPlayer().focus()
        focusPlayer()
      }
    }

    window.addEventListener(seekToEventName, handleSeekTo as EventListener)

    return () => window.removeEventListener(seekToEventName, handleSeekTo as EventListener)
  }, [block.id])

  const focusPlayer = () => {

    // Find all focusable elements inside the player container
    if (containerRef.current) {
      containerRef.current.scrollTo()
      const focusableElements = containerRef.current.querySelectorAll(
        'video, audio, iframe, [tabindex]:not([tabindex="-1"])',
      )

      // Focus the first meaningful element
      if (focusableElements.length > 0) {
        focusableElements[0].focus()
      }
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
