import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.tsx'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useData, usePropertyValue } from '@/hooks/block.ts'
import { BlockChildren } from '@/components/BlockComponent.tsx'
import { Button } from '@/components/ui/button.tsx'
import { PanelRightClose, PanelRightOpen } from 'lucide-react'
import { useShortcutSurfaceActivations } from '@/extensions/blockInteractionContext.tsx'
import {
  blurVideoPlayerEventName,
  currentTimeRequestEventName,
  CurrentTimeRequestEventDetail,
  focusVideoPlayerEventName,
  FocusVideoPlayerEventDetail,
  seekToEventName,
  SeekToEventDetail,
} from './events.ts'
import { videoPlayerViewProp } from './view.ts'

const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const blockData = useData(block)
  const [view, setView] = usePropertyValue(block, videoPlayerViewProp)
  const player = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playerFocused, setPlayerFocused] = useState(false)
  const inNotesView = view === 'notes'
  const nativePlayerSurfaceOptions = useMemo(() => ({playerFocused}), [playerFocused])

  useShortcutSurfaceActivations('video-player-native', nativePlayerSurfaceOptions)

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

  useEffect(() => {
    const handleFocusVideoPlayer = (event: CustomEvent<FocusVideoPlayerEventDetail>) => {
      if (event.detail.blockId !== block.id || !player.current) return

      player.current.focus()
      player.current.scrollIntoView({behavior: 'instant', block: 'nearest'})
      setPlayerFocused(true)
    }

    const handleBlurVideoPlayer = (event: CustomEvent<FocusVideoPlayerEventDetail>) => {
      if (event.detail.blockId !== block.id || !player.current) return

      player.current.blur()
      setPlayerFocused(false)
    }

    window.addEventListener(focusVideoPlayerEventName, handleFocusVideoPlayer as EventListener)
    window.addEventListener(blurVideoPlayerEventName, handleBlurVideoPlayer as EventListener)

    return () => {
      window.removeEventListener(focusVideoPlayerEventName, handleFocusVideoPlayer as EventListener)
      window.removeEventListener(blurVideoPlayerEventName, handleBlurVideoPlayer as EventListener)
    }
  }, [block.id])

  if (!blockData) return null

  return (
    <div
      ref={containerRef}
      className={inNotesView
        ? 'fixed inset-0 z-50 flex flex-col bg-background text-foreground md:flex-row'
        : 'group/video-player relative aspect-video'
      }
    >
      <section
        className={inNotesView
          ? 'flex h-[56vh] w-screen items-center justify-center bg-black md:h-screen md:w-[80vw]'
          : 'h-full w-full'
        }
        onFocusCapture={() => setPlayerFocused(true)}
        onBlurCapture={(event) => {
          const nextTarget = event.relatedTarget
          if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
            setPlayerFocused(false)
          }
        }}
      >
        <div className={inNotesView ? 'aspect-video w-full max-h-full' : 'h-full w-full'}>
          <ReactPlayer
            ref={player}
            src={blockData.content}
            playing={isPlaying}
            controls
            width="100%"
            height="100%"
          />
        </div>
      </section>

      {inNotesView ? (
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
          <BlockChildren block={block}/>
        </aside>
      ) : (
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

const VideoPlayerChildrenRenderer = ({block}: BlockRendererProps) => {
  const [view] = usePropertyValue(block, videoPlayerViewProp)
  if (view === 'notes') return null
  return <BlockChildren block={block}/>
}

export const VideoPlayerRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <NestedBlockContextProvider overrides={{videoPlayerBlockId: props.block.id}}>
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={VideoPlayerContentRenderer}
      ChildrenRenderer={VideoPlayerChildrenRenderer}
    />
  </NestedBlockContextProvider>

VideoPlayerRenderer.canRender = ({block}: BlockRendererProps) =>
{
  const blockData = block.peek()
  return !!(blockData && ReactPlayer.canPlay?.(blockData.content))
}

VideoPlayerRenderer.priority = () => 5
