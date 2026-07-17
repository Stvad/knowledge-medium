import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react'
import { BlockRendererProps, BlockRenderer } from '@/types.js'
import { DefaultBlockRenderer } from '@/components/renderer/DefaultBlockRenderer.js'
import { NestedBlockContextProvider, useBlockContext } from '@/context/block.js'
import { useHandle, usePropertyValue } from '@/hooks/block.js'
import { useUIStateBlock } from '@/data/globalState.js'
import { useRepo } from '@/context/repo.js'
import { Button } from '@/components/ui/button.js'
import { PanelRightClose } from 'lucide-react'
import type { BlockLayout, BlockLayoutContribution } from '@/extensions/blockInteraction.js'
import {
  isPlayableVideoBlock,
  VideoPlayerContentRenderer,
} from './VideoPlayerRenderer.tsx'
import { closeVideoNotesView, ensureEditableVideoNoteChild } from './notes.ts'
import { videoNotesPaneRatioProp, VIDEO_NOTES_VIEW_MODE } from './view.ts'

const MIN_VIDEO_NOTES_PANE_RATIO = 0.28
const MAX_VIDEO_NOTES_PANE_RATIO = 0.9
const VIDEO_NOTES_KEYBOARD_STEP = 0.05

type VideoNotesPaneStyle = CSSProperties & {
  '--video-notes-pane-ratio': string
}

const clampVideoNotesPaneRatio = (ratio: number) =>
  Math.min(MAX_VIDEO_NOTES_PANE_RATIO, Math.max(MIN_VIDEO_NOTES_PANE_RATIO, ratio))

const videoNotesPanePercent = (ratio: number) => `${(ratio * 100).toFixed(2)}%`

const EmptyNotesAffordance = ({block}: BlockRendererProps) => {
  const uiStateBlock = useUIStateBlock()
  const blockContext = useBlockContext()
  if (block.repo.isReadOnly) return null
  const renderScopeId = typeof blockContext.renderScopeId === 'string'
    ? blockContext.renderScopeId
    : undefined
  return (
    <Button
      type="button"
      variant="ghost"
      className="w-full justify-start text-muted-foreground"
      onClick={() => {
        // The gesture creates the first note — the render path never writes.
        void ensureEditableVideoNoteChild(block, uiStateBlock, renderScopeId)
      }}
    >
      Add a note…
    </Button>
  )
}

/**
 * Pane-filling split layout for the video-notes view mode: video region
 * (the shared VideoPlayerContentRenderer) + resizable notes region (the
 * block's children). Ported from the old VideoPlayerLayout notes branch,
 * re-homed from a fixed-viewport overlay to the PANE: `absolute inset-0`
 * inside the panel's relative container, with the pane-height CSS var in
 * container-query units (100cqh) instead of 100vh.
 */
export const VideoNotesLayout: BlockLayout = (slots) => {
  const repo = useRepo()
  const blockContext = useBlockContext()
  const [storedVideoPaneRatio, setStoredVideoPaneRatio] = usePropertyValue(
    slots.block,
    videoNotesPaneRatioProp,
  )
  const [draftVideoPaneRatio, setDraftVideoPaneRatio] = useState<number | null>(null)
  // undefined while the children handle loads — the empty-state affordance
  // must not flash before we KNOW the video has no notes (so no [] default).
  // Identity selector: an id list has nothing narrower to select; the
  // selector exists to satisfy block/no-broad-block-subscriptions.
  const childIds = useHandle(slots.block.repo.query.childIds({id: slots.block.id, hydrate: true, hidePropertyChildren: true}), {
    selector: ids => ids,
  })
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
    // The axis comes from the separator the user actually grabbed, not a px
    // constant: the visible separator is chosen by the @md container query
    // (--container-md = 28rem), and mirroring that threshold in JS would
    // drift (rem-scaled CSS vs raw px) — the 448-767px pane range bit us.
    // aria-orientation="vertical" = the side-by-side column resizer.
    const isDesktopLayout = event.currentTarget.getAttribute('aria-orientation') === 'vertical'
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

  const {Children, Shell} = slots
  const clampedVideoPaneRatio = clampVideoNotesPaneRatio(videoPaneRatio)
  const videoPaneStyle: VideoNotesPaneStyle = {
    flexBasis: videoNotesPanePercent(clampedVideoPaneRatio),
    '--video-notes-pane-ratio': String(clampedVideoPaneRatio),
  }
  const notesPaneStyle: CSSProperties = {
    flexBasis: videoNotesPanePercent(1 - clampedVideoPaneRatio),
  }
  const panelId = typeof blockContext.panelId === 'string' ? blockContext.panelId : undefined
  const stackedPanel = Boolean(blockContext.stackedPanel)

  // The pane-scoped notes view renders its own chrome and ignores the shell
  // props, but still mounts `Shell` so the focused video block keeps its
  // 'block' shortcut surface (play/pause/seek) and shell decorators.
  // Full panel: fill the pane (absolute within the panel's relative
  // container). Stacked panel: the pane is content-sized, so an absolute
  // fill would collapse — size the split explicitly instead. Either way the
  // root is the size container the @md variants and 100cqh units query,
  // which keeps the CSS split axis and the drag handler's rect.width
  // measurement on the SAME box (a narrow pane on a wide viewport splits
  // and drags consistently).
  const notesView = (
    <div
      ref={containerRef}
      data-testid="video-notes-root"
      className={`${stackedPanel ? 'relative h-[70dvh]' : 'absolute inset-0'} [container-type:size]`}
    >
      <div className="flex h-full w-full flex-col bg-background text-foreground @md:flex-row">
      <section
        className="min-h-0 min-w-0 flex-none bg-black [--video-notes-pane-height:calc(100cqh*var(--video-notes-pane-ratio))] @md:[--video-notes-pane-height:100cqh]"
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
        className="group/resizer flex h-2 w-full flex-none cursor-row-resize touch-none items-center justify-center bg-border/80 outline-none transition-colors hover:bg-primary/60 focus-visible:bg-primary/70 focus-visible:ring-1 focus-visible:ring-ring @md:hidden"
        title="Resize video notes panes"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
      >
        <span className="h-1 w-10 rounded-full bg-background/80 transition-colors group-hover/resizer:bg-primary-foreground/90 @md:h-10 @md:w-1"/>
      </div>
      <div
        role="separator"
        tabIndex={0}
        aria-label="Resize video notes panes"
        aria-orientation="vertical"
        aria-valuemax={Math.round(MAX_VIDEO_NOTES_PANE_RATIO * 100)}
        aria-valuemin={Math.round(MIN_VIDEO_NOTES_PANE_RATIO * 100)}
        aria-valuenow={Math.round(clampedVideoPaneRatio * 100)}
        className="group/resizer hidden h-full w-2 flex-none cursor-col-resize touch-none items-center justify-center bg-border/80 outline-none transition-colors hover:bg-primary/60 focus-visible:bg-primary/70 focus-visible:ring-1 focus-visible:ring-ring @md:flex"
        title="Resize video notes panes"
        onKeyDown={handleResizeKeyDown}
        onPointerDown={handleResizePointerDown}
      >
        <span className="h-10 w-1 rounded-full bg-background/80 transition-colors group-hover/resizer:bg-primary-foreground/90"/>
      </div>
      <aside
        className="min-h-0 min-w-0 flex-none overflow-y-auto bg-background p-3"
        style={notesPaneStyle}
        data-children-loaded={childIds === undefined ? undefined : 'true'}
      >
        <div className="pointer-events-none sticky top-2 z-10 -mb-9 flex justify-end">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Close video notes view"
            title="Close video notes view"
            className="pointer-events-auto"
            onClick={() => {
              if (!panelId) return
              void closeVideoNotesView(repo.block(panelId))
            }}
          >
            <PanelRightClose className="h-4 w-4"/>
          </Button>
        </div>
        {/* Clear the mode for everything nested in the notes region: children
            inherit context, and without this a nested/embedded video block
            would re-claim the video-notes renderer recursively. */}
        <NestedBlockContextProvider overrides={{panelViewMode: undefined}}>
          {childIds !== undefined && childIds.length === 0 && <EmptyNotesAffordance block={slots.block}/>}
          <Children/>
        </NestedBlockContextProvider>
      </aside>
      </div>
    </div>
  )

  return <Shell>{() => notesView}</Shell>
}

/** Layout gate: the video block itself, rendered as a pane top-level in
 *  video-notes mode. Children keep their default layouts (they see the
 *  mode CLEARED, and their block id differs from videoPlayerBlockId). */
export const videoNotesLayoutContribution: BlockLayoutContribution = ctx => {
  if (ctx.blockContext?.panelViewMode !== VIDEO_NOTES_VIEW_MODE) return null
  if (ctx.blockContext?.videoPlayerBlockId !== ctx.block.id) return null
  // Same top-level guard as canRender: plain VideoPlayerRenderer also sets
  // videoPlayerBlockId, so a nested inline player under a moded pane would
  // otherwise pull this layout.
  if (!isPaneTopLevelRender({block: ctx.block, context: ctx.blockContext})) return null
  return {
    id: 'video-notes',
    label: 'Video notes',
    render: VideoNotesLayout,
  }
}

/**
 * Contextually-selected renderer for a pane in the `video-notes` view mode
 * (design §4.3): same shell/content arrangement as VideoPlayerRenderer —
 * DefaultBlockRenderer keeps the block shell, shortcut surfaces, and the
 * player-handle registry working; `videoPlayerBlockId` marks the subtree
 * for the video shortcut activation; the split itself comes from
 * `videoNotesLayoutContribution` above. The MODE stays visible in context
 * here (the layout gate and the video region's styling read it); it is
 * cleared around the NOTES region inside the layout.
 */
export const VideoNotesRenderer: BlockRenderer = (props: BlockRendererProps) =>
  <NestedBlockContextProvider overrides={{videoPlayerBlockId: props.block.id}}>
    <DefaultBlockRenderer
      {...props}
      ContentRenderer={VideoPlayerContentRenderer}
    />
  </NestedBlockContextProvider>

/** True only for the pane's TOP-LEVEL render of `block`: PanelRenderer sets
 *  `scopeRootId` to the top-level block id, while embeds/refs/backlinks
 *  re-point `scopeRootId` to their shown block AND stamp `isNestedSurface`.
 *  Without this guard, a `;view=video-notes` hash over a NON-video top-level
 *  would let every nested playable block hijack the pane with the split. */
const isPaneTopLevelRender = ({block, context}: BlockRendererProps): boolean =>
  context?.scopeRootId === block.id && !context?.isNestedSurface

VideoNotesRenderer.canRender = (props: BlockRendererProps) =>
  props.context?.panelViewMode === VIDEO_NOTES_VIEW_MODE &&
  isPaneTopLevelRender(props) &&
  isPlayableVideoBlock(props.block)

// Above VideoPlayerRenderer (5): in the mode, the notes arrangement wins.
VideoNotesRenderer.priority = () => 10
