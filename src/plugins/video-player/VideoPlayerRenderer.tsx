import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import {
  DefaultBlockLayout,
  DefaultBlockRenderer,
} from '@/components/renderer/DefaultBlockRenderer.tsx'
import { useEffect, useRef, useState } from 'react'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useContent, usePropertyValue } from '@/hooks/block.ts'
import { Button } from '@/components/ui/button.tsx'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import type {
  BlockLayout,
  BlockLayoutContribution,
} from '@/extensions/blockInteraction.ts'
import {
  currentTimeRequestEventName,
  CurrentTimeRequestEventDetail,
  seekToEventName,
  SeekToEventDetail,
} from './events.ts'
import { videoPlayerViewProp } from './view.ts'

const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const content = useContent(block)
  const [view, setView] = usePropertyValue(block, videoPlayerViewProp)
  const player = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const inNotesView = view === 'notes'

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

  useEffect(() => {
    const handleCurrentTimeRequest = (event: CustomEvent<CurrentTimeRequestEventDetail>) => {
      if (event.detail.blockId === block.id && player.current) {
        event.detail.respond(player.current.currentTime)
      }
    }

    window.addEventListener(currentTimeRequestEventName, handleCurrentTimeRequest as EventListener)

    return () => window.removeEventListener(
      currentTimeRequestEventName,
      handleCurrentTimeRequest as EventListener,
    )
  }, [block.id])

  return (
    <div
      ref={containerRef}
      className={inNotesView
        ? 'flex h-full w-full items-center justify-center bg-black'
        : 'group/video-player relative aspect-video'
      }
    >
      <div className={inNotesView ? 'aspect-video w-full max-h-full' : 'h-full w-full'}>
        <ReactPlayer
          ref={player}
          src={content}
          playing={isPlaying}
          controls
          width="100%"
          height="100%"
        />
      </div>

      {!inNotesView && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Open video notes view"
          title="Open video notes view"
          className="absolute right-2 top-2 opacity-0 shadow-md transition-opacity group-hover/video-player:opacity-100 focus-visible:opacity-100"
          onClick={() => setView('notes')}
        >
          <PanelRightOpen className="h-4 w-4"/>
        </Button>
      )}
    </div>
  )
}

/**
 * Layout for the video block itself. Subscribes to the view property so a
 * toggle on the *parent layout* re-renders without forcing every consumer to
 * re-resolve the layout facet. Falls through to the default vertical layout
 * unless the block is in notes view, where it lays out content+children
 * side-by-side as a fullscreen overlay.
 */
const VideoPlayerLayout: BlockLayout = (slots) => {
  const [view, setView] = usePropertyValue(slots.block, videoPlayerViewProp)

  if (view !== 'notes') {
    return <DefaultBlockLayout {...slots}/>
  }

  const {Content, Children} = slots
  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-background text-foreground md:flex-row">
      <section className="flex h-[56vh] w-screen items-center justify-center bg-black md:h-screen md:w-[80vw]">
        <Content/>
      </section>
      <aside className="h-[44vh] w-screen overflow-y-auto border-t border-border bg-background p-3 md:h-screen md:w-[20vw] md:border-l md:border-t-0">
        <div className="sticky top-0 z-10 mb-2 flex justify-end bg-background/95 pb-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close video notes view"
            title="Close video notes view"
            onClick={() => setView('default')}
          >
            <PanelRightClose className="h-4 w-4"/>
          </Button>
        </div>
        <Children/>
      </aside>
    </div>
  )
}

/**
 * Only contribute a layout for the actual video block — child note blocks
 * inherit `videoPlayerBlockId` from the surrounding NestedBlockContext, so we
 * gate on `block.id === videoPlayerBlockId` to leave child layouts alone.
 */
export const videoPlayerLayoutContribution: BlockLayoutContribution = ctx => {
  const videoBlockId = ctx.blockContext?.videoPlayerBlockId
  if (videoBlockId !== ctx.block.id) return null
  return VideoPlayerLayout
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
