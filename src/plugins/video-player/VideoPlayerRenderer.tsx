import ReactPlayer from 'react-player'
import { BlockRendererProps, BlockRenderer } from '@/types.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { useContent } from '@/hooks/block.js'
import { useUIStateBlock } from '@/data/globalState.js'
import { topLevelBlockIdProp } from '@/data/properties.js'
import type { Block } from '@/data/block'
import { Button } from '@/components/ui/button.js'
import { PanelRightOpen } from 'lucide-react'
import { registerVideoPlayer } from './registry.ts'
import { enterVideoNotesView } from './notes.ts'
import { VIDEO_NOTES_VIEW_MODE } from './view.ts'

const URL_ONLY_WHITESPACE_RE = /\s/

const standaloneHttpUrl = (content: string) => {
  const url = content.trim()
  if (!url || URL_ONLY_WHITESPACE_RE.test(url)) return null

  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? url : null
  } catch {
    return null
  }
}

/** The playability gate shared by VideoPlayerRenderer and (with the mode
 *  check on top) VideoNotesRenderer: the block content is exactly one
 *  playable http(s) URL. */
export const isPlayableVideoBlock = (block: Block): boolean => {
  const blockData = block.peek()
  const url = blockData ? standaloneHttpUrl(blockData.content) : null
  return !!(url && ReactPlayer.canPlay?.(url))
}

/** The shared video CONTENT renderer (the design's arrangement/rendering
 *  split): both the inline player (VideoPlayerRenderer) and the notes-view
 *  video region (VideoNotesLayout) mount this. Notes-view styling keys off
 *  the pane mode in context — inside the notes layout the mode is still
 *  set; nested copies see it cleared and render the inline arrangement. */
export const VideoPlayerContentRenderer = ({block}: BlockRendererProps) => {
  const content = useContent(block)
  const uiStateBlock = useUIStateBlock()
  const blockContext = useBlockContext()
  const player = useRef<HTMLVideoElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const [isPlaying, setIsPlaying] = useState(false)
  const inNotesView = blockContext.panelViewMode === VIDEO_NOTES_VIEW_MODE
  const notesPlayerFrameStyle = inNotesView
    ? {width: 'min(100%, calc(var(--video-notes-pane-height) * 16 / 9))'}
    : undefined
  const notesPlayerStyle = inNotesView
    ? {width: '100%', height: 'auto', aspectRatio: '16 / 9'}
    : undefined

  const focusPlayer = useCallback((): boolean => {
    const focusTarget = player.current ?? containerRef.current
    if (!focusTarget) return false

    containerRef.current?.scrollIntoView({block: 'nearest'})
    focusTarget.focus({preventScroll: true})
    return true
  }, [])

  const hasPlayerFocus = useCallback((): boolean => {
    const container = containerRef.current
    const playerElement = player.current
    const activeElement = document.activeElement

    if (
      activeElement &&
      (
        activeElement === playerElement ||
        activeElement === container ||
        Boolean(container?.contains(activeElement))
      )
    ) {
      return true
    }

    return Boolean(playerElement?.shadowRoot?.activeElement)
  }, [])

  const renderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : undefined

  // The enter gesture needs a PANE to put into the mode; on non-panel
  // surfaces (root ui-state, preview modals) it would silently no-op — hide
  // the affordance there. Same predicate as enterVideoNotesView's guard.
  const canEnterNotesView = uiStateBlock.peekProperty(topLevelBlockIdProp) !== undefined

  // Register a typed imperative handle for this rendered player, keyed by
  // block id + render scope. Replaces the old window.CustomEvent
  // request/response bus — actions and timestamp links resolve the
  // player in their own render scope and call it synchronously.
  useEffect(() => registerVideoPlayer(block.id, renderScopeId, {
    getCurrentTime: () => player.current?.currentTime,
    focus: focusPlayer,
    hasFocus: hasPlayerFocus,
    seekTo: seconds => {
      if (!player.current) return
      player.current.currentTime = seconds
      focusPlayer()
      setIsPlaying(true)
    },
  }), [block.id, renderScopeId, focusPlayer, hasPlayerFocus])

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
          // Keep the controlled `playing` prop truthful to native playback so
          // react-player's enforcement effect is a no-op on re-run. Without
          // this, a video started via the native controls kept playing===false
          // and survived only because nothing re-rendered — any re-render
          // would have paused it.
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          controls
          tabIndex={0}
          aria-label="Video player"
          width="100%"
          height="100%"
          style={notesPlayerStyle}
        />
      </div>

      {!inNotesView && canEnterNotesView && (
        <Button
          type="button"
          variant="secondary"
          size="icon"
          aria-label="Open video notes view"
          title="Open video notes view"
          className="absolute right-2 top-2 opacity-0 shadow-md transition-opacity group-hover/video-player:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            // uiStateBlock IS the panel row in panel contexts — the enter
            // gesture puts the PANE into the video-notes mode via the composed
            // navigateInPanel({viewMode}) (same-block = mode-only tx).
            void enterVideoNotesView(block, uiStateBlock)
          }}
        >
          <PanelRightOpen className="h-4 w-4"/>
        </Button>
      )}
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

VideoPlayerRenderer.canRender = ({block}: BlockRendererProps) => isPlayableVideoBlock(block)

VideoPlayerRenderer.priority = () => 5
