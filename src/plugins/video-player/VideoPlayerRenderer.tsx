import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.ts'
import {
  DefaultBlockLayout,
  DefaultBlockRenderer,
} from '@/components/renderer/DefaultBlockRenderer.tsx'
import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useContent, usePropertyValue } from '@/hooks/block.ts'
import { useUIStateBlock } from '@/data/globalState.ts'
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
import { enterVideoNotesView } from './notes.ts'
import { videoNotesPaneRatioProp, videoPlayerViewProp } from './view.ts'

const MIN_VIDEO_NOTES_PANE_RATIO = 0.28
const MAX_VIDEO_NOTES_PANE_RATIO = 0.9
const VIDEO_NOTES_DESKTOP_BREAKPOINT = 768
const VIDEO_NOTES_KEYBOARD_STEP = 0.05

type VideoNotesPaneStyle = CSSProperties & {
  '--video-notes-pane-ratio': string
}

const clampVideoNotesPaneRatio = (ratio: number) =>
  Math.min(MAX_VIDEO_NOTES_PANE_RATIO, Math.max(MIN_VIDEO_NOTES_PANE_RATIO, ratio))

const videoNotesPanePercent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`

const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const content = useContent(block)
  const [view] = usePropertyValue(block, videoPlayerViewProp)
  const uiStateBlock = useUIStateBlock()
  const player = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const inNotesView = view === 'notes'
  const notesPlayerFrameStyle = inNotesView
    ? {width: 'min(100%, calc(var(--video-notes-pane-height) * 16 / 9))'}
    : undefined
  const notesPlayerStyle = inNotesView
    ? {width: '100%', height: 'auto', aspectRatio: '16 / 9'}
    : undefined

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
        ? 'grid h-full w-full place-items-center bg-black'
        : 'group/video-player relative aspect-video'
      }
    >
      <div
        className={inNotesView ? 'm-auto max-h-full max-w-full' : 'h-full w-full'}
        style={notesPlayerFrameStyle}
      >
        <ReactPlayer
          ref={player}
          src={content}
          playing={isPlaying}
          controls
          width="100%"
          height="100%"
          style={notesPlayerStyle}
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
          onClick={() => { void enterVideoNotesView(block, uiStateBlock) }}
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
  const [storedVideoPaneRatio, setStoredVideoPaneRatio] = usePropertyValue(
    slots.block,
    videoNotesPaneRatioProp,
  )
  const [draftVideoPaneRatio, setDraftVideoPaneRatio] = useState<number | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const dragCleanupRef = useRef<(() => void) | null>(null)
  const videoPaneRatio = draftVideoPaneRatio ?? storedVideoPaneRatio

  useEffect(() => () => {
    dragCleanupRef.current?.()
  }, [])

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return

    const container = containerRef.current
    if (!container) return

    dragCleanupRef.current?.()

    const rect = container.getBoundingClientRect()
    const isDesktopLayout = rect.width >= VIDEO_NOTES_DESKTOP_BREAKPOINT
    const totalSize = isDesktopLayout ? rect.width : rect.height
    if (totalSize <= 0) return

    const previousCursor = document.body.style.cursor
    const previousUserSelect = document.body.style.userSelect
    let latestRatio = clampVideoNotesPaneRatio(videoPaneRatio)

    const updateRatio = (clientX: number, clientY: number) => {
      const offset = isDesktopLayout ? clientX - rect.left : clientY - rect.top
      latestRatio = clampVideoNotesPaneRatio(offset / totalSize)
      setDraftVideoPaneRatio(latestRatio)
    }

    const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
      moveEvent.preventDefault()
      updateRatio(moveEvent.clientX, moveEvent.clientY)
    }

    const cleanupPointerListeners = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
      document.body.style.cursor = previousCursor
      document.body.style.userSelect = previousUserSelect
      dragCleanupRef.current = null
    }

    const finishResize = (commit: boolean) => {
      cleanupPointerListeners()
      setDraftVideoPaneRatio(null)
      if (commit) setStoredVideoPaneRatio(latestRatio)
    }

    const handlePointerUp = (upEvent: globalThis.PointerEvent) => {
      upEvent.preventDefault()
      finishResize(true)
    }

    const handlePointerCancel = (cancelEvent: globalThis.PointerEvent) => {
      cancelEvent.preventDefault()
      finishResize(false)
    }

    document.body.style.cursor = isDesktopLayout ? 'col-resize' : 'row-resize'
    document.body.style.userSelect = 'none'
    window.addEventListener('pointermove', handlePointerMove, {passive: false})
    window.addEventListener('pointerup', handlePointerUp, {passive: false})
    window.addEventListener('pointercancel', handlePointerCancel, {passive: false})

    dragCleanupRef.current = cleanupPointerListeners
    event.preventDefault()
    updateRatio(event.clientX, event.clientY)
  }

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const deltas: Partial<Record<string, number>> = {
      ArrowDown: VIDEO_NOTES_KEYBOARD_STEP,
      ArrowRight: VIDEO_NOTES_KEYBOARD_STEP,
      ArrowLeft: -VIDEO_NOTES_KEYBOARD_STEP,
      ArrowUp: -VIDEO_NOTES_KEYBOARD_STEP,
      End: MAX_VIDEO_NOTES_PANE_RATIO - videoPaneRatio,
      Home: MIN_VIDEO_NOTES_PANE_RATIO - videoPaneRatio,
    }
    const delta = deltas[event.key]
    if (delta === undefined) return

    event.preventDefault()
    setDraftVideoPaneRatio(null)
    setStoredVideoPaneRatio(clampVideoNotesPaneRatio(videoPaneRatio + delta))
  }

  if (view !== 'notes') {
    return <DefaultBlockLayout {...slots}/>
  }

  const {Children} = slots
  const clampedVideoPaneRatio = clampVideoNotesPaneRatio(videoPaneRatio)
  const videoPaneStyle: VideoNotesPaneStyle = {
    flexBasis: videoNotesPanePercent(clampedVideoPaneRatio),
    '--video-notes-pane-ratio': String(clampedVideoPaneRatio),
  }
  const notesPaneStyle: CSSProperties = {
    flexBasis: videoNotesPanePercent(1 - clampedVideoPaneRatio),
  }

  return (
    <div
      ref={containerRef}
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground md:flex-row"
    >
      <section
        className="min-h-0 min-w-0 flex-none bg-black [--video-notes-pane-height:calc(100vh*var(--video-notes-pane-ratio))] md:[--video-notes-pane-height:100vh]"
        style={videoPaneStyle}
      >
        <VideoPlayerContentRenderer block={slots.block}/>
      </section>
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize video notes panes"
        aria-orientation="horizontal"
        aria-valuemax={Math.round(MAX_VIDEO_NOTES_PANE_RATIO * 100)}
        aria-valuemin={Math.round(MIN_VIDEO_NOTES_PANE_RATIO * 100)}
        aria-valuenow={Math.round(clampedVideoPaneRatio * 100)}
        className="group/resizer flex h-2 w-full flex-none cursor-row-resize touch-none items-center justify-center bg-border/80 outline-none transition-colors hover:bg-primary/60 focus-visible:bg-primary/70 focus-visible:ring-1 focus-visible:ring-ring md:hidden"
        title="Resize video notes panes"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
      >
        <span className="h-1 w-10 rounded-full bg-background/80 transition-colors group-hover/resizer:bg-primary-foreground/90 md:h-10 md:w-1"/>
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize video notes panes"
        aria-orientation="vertical"
        aria-valuemax={Math.round(MAX_VIDEO_NOTES_PANE_RATIO * 100)}
        aria-valuemin={Math.round(MIN_VIDEO_NOTES_PANE_RATIO * 100)}
        aria-valuenow={Math.round(clampedVideoPaneRatio * 100)}
        className="group/resizer hidden h-full w-2 flex-none cursor-col-resize touch-none items-center justify-center bg-border/80 outline-none transition-colors hover:bg-primary/60 focus-visible:bg-primary/70 focus-visible:ring-1 focus-visible:ring-ring md:flex"
        title="Resize video notes panes"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
      >
        <span className="h-10 w-1 rounded-full bg-background/80 transition-colors group-hover/resizer:bg-primary-foreground/90"/>
      </div>
      <aside
        className="min-h-0 min-w-0 flex-none overflow-y-auto bg-background p-3"
        style={notesPaneStyle}
      >
        <div className="pointer-events-none sticky top-2 z-10 -mb-9 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close video notes view"
            title="Close video notes view"
            className="pointer-events-auto"
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
