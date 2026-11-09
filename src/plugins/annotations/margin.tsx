/**
 * The comments margin: a card per thread beside its target row, in a column
 * to the right of the panel's text frame, in document order.
 *
 * A panel mount, so it composes with whatever layout renders the panel. It
 * uses the width a wide panel leaves empty beside the text first, then moves
 * the text left, then narrows it (`fitColumn`, `PANEL_RIGHT_CLEARANCE`). Its
 * width is automatic until dragged, and the dragged width is kept on the
 * layout column's row (`annotationMarginWidthProp`). The cost is that it
 * lives outside the scrollport: it finds the panel's rows in the DOM (mounted
 * rows and lazy placeholders alike, of the panel's own render scope), reads
 * their positions and moves the cards within one animation frame of a scroll
 * or a re-render, and within the frame of a resize.
 *
 * A card sits beside its target row's top, or, for a quote, beside the line
 * the quote starts on (`quoteTop`).
 *
 * Where even the narrowed text leaves no room, it draws nothing and says so
 * (`setMarginShowing`), and the comment pill falls back to expanding threads
 * inline.
 */

import {createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode, type WheelEvent} from 'react'
import {MessageSquare, X} from 'lucide-react'
import type {Block} from '@/data/block'
import {isCollapsedProp, topLevelBlockIdProp} from '@/data/properties.js'
import {NestedBlockContextProvider} from '@/context/block.js'
import {scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction.js'
import {useRepo} from '@/context/repo.js'
import {useHandle, usePropertyValue, useWorkspaceId} from '@/hooks/block.js'
import {PANEL_RIGHT_CLEARANCE, PANEL_TEXT_MIN_WIDTH_PX} from '@/utils/panelClearance.js'
import {isPanelStackRow} from '@/utils/panelLayoutProjection.js'
import {panelRenderScopeId} from '@/utils/renderScope.js'
import {annotationMarginOpenProp, annotationMarginWidthProp} from './marginSchema.ts'
import {byPlacement, fitColumn, placeCards} from './placement.ts'
import {quoteTop} from './quotePosition.ts'
import type {RangeAnchor} from './anchor.ts'
import {THREADS_IN_SCOPE_QUERY, type ScopeThread} from './scopeThreads.ts'
import {ThreadCard, useThreadSummaries} from './ui.tsx'
import {
  activateThread,
  onUiStoreChange,
  peekActiveThread,
  setMarginShowing,
  toggleShowClosed,
  useActiveThread,
  useShowClosed,
} from './uiStore.ts'

/** The column's width bounds, and the space kept on each side of it. A panel
 *  without room for the minimum beside the narrowest text shows no margin.
 *  The maximum bounds the automatic width, so the column doesn't outweigh the
 *  text unless dragged to. */
const COLUMN_BOUNDS = {min: 240, max: 520}
const EDGE_PX = 16
/** The resize handle, centred in the gap left of the column. */
const HANDLE_WIDTH_PX = 8
/** How far a press moves before it is a drag; a click's jitter is not. */
const DRAG_THRESHOLD_PX = 3
const CARD_GAP_PX = 8

interface ColumnFrame {
  left: number
  top: number
  width: number
  height: number
  /** How much of the pane's right the text gives up to the column. */
  clearance: number
}

const sameFrame = (a: ColumnFrame | null, b: ColumnFrame | null): boolean =>
  a === b || (a !== null && b !== null &&
    a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height && a.clearance === b.clearance)

/** A card slot: where a card registers its element for the layout pass. */
interface CardEntry {
  el: HTMLElement
  blockId: string
  /** Position among its block's cards (whole-block first, then by quote). */
  order: number
  /** A quote's anchor, placing the card beside the quote; absent for a
   *  whole-block card. */
  quote?: RangeAnchor
  /** See {@link MarginCard}. */
  trailing?: boolean
}

interface MarginRegistry {
  panelId: string
  register: (key: string, entry: CardEntry) => () => void
}

const MarginRegistryContext = createContext<MarginRegistry | null>(null)

export const CommentMargin = ({block}: {block: Block}) => {
  const [open] = usePropertyValue(block, annotationMarginOpenProp)
  const [topLevelBlockId] = usePropertyValue(block, topLevelBlockIdProp)
  if (!open || !topLevelBlockId) return null
  return <MarginColumn panelBlock={block} topLevelBlockId={topLevelBlockId}/>
}

/** Where the margin's width is kept: the layout column the panel shows in,
 *  which is its stack when it has one. */
const useWidthOwner = (panelBlock: Block): Block => {
  const repo = useRepo()
  const parentId = useHandle(panelBlock, {selector: data => data?.parentId ?? null})
  const parent = repo.block(parentId ?? panelBlock.id)
  const inStack = useHandle(parent, {selector: data => parentId !== null && data != null && isPanelStackRow(data)})
  return inStack ? parent : panelBlock
}

const MarginColumn = ({panelBlock, topLevelBlockId}: {panelBlock: Block; topLevelBlockId: string}) => {
  const panelId = panelBlock.id
  const widthOwner = useWidthOwner(panelBlock)
  const [storedWidth] = usePropertyValue(widthOwner, annotationMarginWidthProp)
  /** The width the layout pass asks for: the stored one, or a drag's. */
  const preferredWidth = useRef(storedWidth)
  const scope = panelRenderScopeId(panelId, topLevelBlockId)
  const probeRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<ColumnFrame | null>(null)
  const [rows, setRows] = useState<readonly string[]>([])
  const cards = useRef(new Map<string, CardEntry>())
  /** The layout pass, bound while the column is mounted: `schedule` runs it
   *  in the next animation frame, `flush` runs it now and returns its frame. */
  const layout = useRef(IDLE_LAYOUT)
  const scrollportRef = useRef<HTMLElement | null>(null)
  const cardObserver = useRef<ResizeObserver | null>(null)
  const repo = useRepo()

  const [registry] = useState<MarginRegistry>(() => ({
    panelId,
    register: (key, entry) => {
      cards.current.set(key, entry)
      cardObserver.current?.observe(entry.el)
      layout.current.schedule()
      return () => {
        if (cards.current.get(key) === entry) cards.current.delete(key)
        cardObserver.current?.unobserve(entry.el)
        layout.current.schedule()
      }
    },
  }))

  useLayoutEffect(() => {
    const panelEl = probeRef.current?.closest<HTMLElement>('[data-panel-id]')
    const scrollport = panelEl?.querySelector<HTMLElement>('[data-panel-scrollport]')
    if (!panelEl || !scrollport) return
    scrollportRef.current = scrollport
    const selector = scopeRowSelector(scope)
    let pending = 0
    /** Room added below the outline so the last cards, pushed below the last
     *  row, can be scrolled to. Inline style, which React leaves alone on the
     *  scrollport, and removed with the margin. */
    let extraBottom = 0
    const setExtraBottom = (px: number) => {
      if (px === extraBottom) return
      extraBottom = px
      scrollport.style.paddingBottom = px > 0 ? `${px}px` : ''
    }

    const topRowSelector =
      `[data-block-shell][data-block-id="${CSS.escape(topLevelBlockId)}"][data-render-scope-id="${CSS.escape(scope)}"]`
    /** The focal block's row spans the whole outline, so its size changes
     *  whenever any row's does, an image that finished loading included. It
     *  is re-found each pass, since the row can remount. */
    let observedTopRow: Element | null = null

    const setClearance = (px: number) => {
      if (px > 0) panelEl.style.setProperty(PANEL_RIGHT_CLEARANCE, `${px}px`)
      else panelEl.style.removeProperty(PANEL_RIGHT_CLEARANCE)
    }

    /** From the pane's width alone, which the clearance (padding) leaves
     *  as it is, and the text frame's maximum width as the CSS resolves it
     *  (`max-w-3xl` is in rem). */
    const measure = (portRect: DOMRect): ColumnFrame | null => {
      const panelRect = panelEl.getBoundingClientRect()
      const frameEl = scrollport.firstElementChild
      const textMax = frameEl ? Number.parseFloat(getComputedStyle(frameEl).maxWidth) : Number.NaN
      const fit = fitColumn({
        pane: portRect.width,
        preferred: preferredWidth.current,
        text: {min: PANEL_TEXT_MIN_WIDTH_PX, max: Number.isFinite(textMax) ? textMax : portRect.width},
        column: COLUMN_BOUNDS,
        edge: EDGE_PX,
      })
      return fit && {
        left: Math.round(portRect.left - panelRect.left + fit.left),
        top: Math.round(portRect.top - panelRect.top),
        width: fit.width,
        height: Math.round(portRect.height),
        clearance: fit.clearance,
      }
    }

    const run = (): ColumnFrame | null => {
      pending = 0
      const topRow = scrollport.querySelector(topRowSelector)
      if (topRow !== observedTopRow) {
        if (observedTopRow) resize.unobserve(observedTopRow)
        if (topRow) resize.observe(topRow)
        observedTopRow = topRow
      }
      const portRect = scrollport.getBoundingClientRect()
      const nextFrame = topRow && measure(portRect)
      setFrame(current => sameFrame(current, nextFrame) ? current : nextFrame)
      setClearance(nextFrame?.clearance ?? 0)
      const rowEls = new Map<string, Element>()
      for (const el of scrollport.querySelectorAll<HTMLElement>(selector)) {
        const id = scopeRowBlockId(el)
        if (id && !rowEls.has(id)) rowEls.set(id, el)
      }
      const order = [...rowEls.keys()]
      setRows(current => current.length === order.length && current.every((id, i) => id === order[i]) ? current : order)
      const column = columnRef.current
      if (!column || !topRow || !nextFrame) {
        setExtraBottom(0)
        return nextFrame
      }
      // Ahead of React's commit of `frame`, which lands after this frame's
      // paint: the text has already moved.
      Object.assign(column.style, frameStyle(nextFrame))
      const columnTop = column.getBoundingClientRect().top
      const anchorTop = (entry: CardEntry, row: Element): number => {
        const rowTop = row.getBoundingClientRect().top
        const quoted = entry.quote
          ? quoteTop(row, entry.blockId, scope, entry.quote, repo.block(entry.blockId).peek()?.content)
          : null
        return Math.max(rowTop, quoted ?? rowTop) - columnTop
      }
      const rowIndex = new Map(order.map((id, i) => [id, i]))
      const placed = [...cards.current.entries()]
        .filter(([, entry]) => rowIndex.has(entry.blockId))
        .map(([key, entry]) => ({
          key,
          entry,
          row: rowIndex.get(entry.blockId)!,
          anchor: anchorTop(entry, rowEls.get(entry.blockId)!),
          trailing: entry.trailing ?? false,
          order: entry.order,
        }))
        .sort(byPlacement)
      const boxes = placed.map(card => ({anchor: card.anchor, height: card.entry.el.offsetHeight}))
      const active = peekActiveThread(panelId)
      const tops = placeCards(boxes, placed.findIndex(card => card.key === active), CARD_GAP_PX, nextFrame.height)
      for (const [i, {entry}] of placed.entries()) {
        entry.el.style.transform = `translateY(${Math.round(tops[i])}px)`
        entry.el.style.visibility = 'visible'
        entry.el.style.opacity = ''
      }
      for (const [, entry] of cards.current) {
        if (!rowIndex.has(entry.blockId)) entry.el.style.visibility = 'hidden'
      }
      const last = tops.length - 1
      const cardsEnd = last < 0 ? 0 : scrollport.scrollTop + tops[last] + boxes[last].height + CARD_GAP_PX
      // From the outline itself, not `scrollHeight`: on a page shorter than
      // the viewport that is the viewport's height, so the padding would
      // converge on its size a frame at a time.
      const contentEnd = topRow.getBoundingClientRect().bottom - portRect.top + scrollport.scrollTop
      setExtraBottom(Math.max(0, Math.ceil(cardsEnd - contentEnd)))
      return nextFrame
    }
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(run)
    }
    const flush = () => {
      cancelAnimationFrame(pending)
      return run()
    }
    layout.current = {schedule, flush}

    // Before this frame's paint, so text narrowed by a resize and the column
    // beside it move together.
    const resize = new ResizeObserver(flush)
    resize.observe(panelEl)
    resize.observe(scrollport)
    cardObserver.current = resize
    for (const entry of cards.current.values()) resize.observe(entry.el)
    // Rows mounting or unmounting, which can leave the outline's height as it
    // was (a placeholder swapped for its row), and text changing in place,
    // which can move a quote to another line at the same height.
    const mutations = new MutationObserver(schedule)
    mutations.observe(scrollport, {childList: true, characterData: true, subtree: true})
    scrollport.addEventListener('scroll', schedule, {passive: true})
    const unsubscribe = onUiStoreChange(schedule)
    schedule()
    return () => {
      cancelAnimationFrame(pending)
      resize.disconnect()
      cardObserver.current = null
      mutations.disconnect()
      scrollport.removeEventListener('scroll', schedule)
      unsubscribe()
      setExtraBottom(0)
      setClearance(0)
      layout.current = IDLE_LAYOUT
    }
  }, [panelId, scope, topLevelBlockId, repo])

  const applyStoredWidth = () => {
    preferredWidth.current = storedWidth
    layout.current.schedule()
  }
  useEffect(applyStoredWidth, [storedWidth])

  const showing = frame !== null
  useEffect(() => {
    setMarginShowing(panelId, showing)
    return () => setMarginShowing(panelId, false)
  }, [panelId, showing])

  const workspaceId = useWorkspaceId(repo.block(topLevelBlockId), repo.activeWorkspaceId ?? '')
  /** Null while loading, which is not "no comments". */
  const loadedThreads = useHandle(
    repo.query[THREADS_IN_SCOPE_QUERY]({workspaceId, scopeId: topLevelBlockId}),
    {selector: threads => threads ?? null},
  )
  const scopeThreads = loadedThreads ?? NO_SCOPE_THREADS
  const showClosed = useShowClosed(panelId)
  const hosts = useMemo(
    () => marginHosts(scopeThreads, rows, topLevelBlockId, showClosed),
    [scopeThreads, rows, topLevelBlockId, showClosed],
  )

  // The column is outside the scrollport, so a wheel over a card would scroll
  // nothing; hand it to the outline.
  const forwardWheel = (event: WheelEvent) => {
    if (!event.ctrlKey) scrollportRef.current?.scrollBy({top: event.deltaY, left: 0})
  }

  return (
    <>
      <div ref={probeRef} hidden/>
      {frame && (
        <WidthHandle
          frame={frame}
          onDrag={width => {
            preferredWidth.current = width
            layout.current.schedule()
          }}
          onEnd={() => {
            const width = layout.current.flush()?.width
            if (width === undefined || width === storedWidth) applyStoredWidth()
            else void widthOwner.set(annotationMarginWidthProp, width)
          }}
          onCancel={applyStoredWidth}
          onReset={() => void widthOwner.set(annotationMarginWidthProp, undefined)}
        />
      )}
      {frame && (
        <div
          ref={columnRef}
          aria-label="Comments margin"
          role="complementary"
          onWheel={forwardWheel}
          className="pointer-events-none absolute z-[5] overflow-clip"
          style={frameStyle(frame)}
        >
          <MarginRegistryContext value={registry}>
            <NestedBlockContextProvider overrides={{layoutBoundary: false, renderScopeId: scope, scopeRootId: topLevelBlockId}}>
              {loadedThreads?.length === 0 && (
                <p className="px-1 pt-1 text-xs text-muted-foreground">No comments here.</p>
              )}
              <MarginFooter panelBlock={panelBlock} hasThreads={scopeThreads.length > 0}/>
              {hosts.cardRows.map(blockId => <MarginRow key={blockId} blockId={blockId}/>)}
              {[...hosts.stubs].map(([blockId, count]) => <HiddenThreadsStub key={blockId} blockId={blockId} count={count}/>)}
            </NestedBlockContextProvider>
          </MarginRegistryContext>
        </div>
      )}
    </>
  )
}

const NO_SCOPE_THREADS: readonly ScopeThread[] = Object.freeze([])

const IDLE_LAYOUT = {schedule: () => {}, flush: (): ColumnFrame | null => null}

const frameStyle = (frame: ColumnFrame) =>
  ({left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, height: `${frame.height}px`})

export interface MarginHosts {
  /** Rendered rows with cards of their own, in outline order. */
  cardRows: readonly string[]
  /** Rendered rows standing in for open threads whose own row isn't
   *  rendered (inside a collapsed block, or not mounted yet): how many. */
  stubs: ReadonlyMap<string, number>
}

/** Where each thread of the scope shows: on its target's row when that row is
 *  rendered, else as a count on the nearest rendered ancestor. Closed threads
 *  show only when asked for, and never as a count. */
export const marginHosts = (
  threads: readonly ScopeThread[],
  rows: readonly string[],
  scopeId: string,
  showClosed: boolean,
): MarginHosts => {
  const rendered = new Set(rows)
  const withCards = new Set<string>()
  const stubs = new Map<string, number>()
  for (const thread of threads) {
    if (!thread.open && !showClosed) continue
    const host = [...thread.path, scopeId].find(id => rendered.has(id))
    if (host === undefined) continue
    if (host === (thread.path[0] ?? scopeId)) withCards.add(host)
    else if (thread.open) stubs.set(host, (stubs.get(host) ?? 0) + 1)
  }
  return {cardRows: rows.filter(id => withCards.has(id)), stubs}
}

const MarginRow = ({blockId}: {blockId: string}) => {
  const registry = useContext(MarginRegistryContext)!
  const repo = useRepo()
  const threads = useThreadSummaries(repo.block(blockId))
  const showClosed = useShowClosed(registry.panelId)
  return threads.map((thread, order) => (thread.open || showClosed) && (
    <CardSlot
      key={thread.id}
      slotKey={thread.id}
      blockId={blockId}
      order={order}
      quote={thread.anchor.kind === 'range' ? thread.anchor : undefined}
    >
      <div className={thread.open ? undefined : 'opacity-70'}>
        <ThreadCard thread={thread} surface="margin"/>
      </div>
    </CardSlot>
  ))
}

/** Keyboard focus, which can't be aimed at a card that is about to move. A
 *  pointer press can, so it activates on the click, after the press has
 *  landed: pinning on press would move the card out from under it. */
const isKeyboardFocus = (event: FocusEvent): boolean => {
  try {
    return (event.target as Element).matches(':focus-visible')
  } catch {
    return false
  }
}

interface CardSlotProps {
  slotKey: string
  blockId: string
  order: number
  quote?: RangeAnchor
  trailing?: boolean
  children: ReactNode
}

const CardSlot = ({slotKey, blockId, order, quote, trailing, children}: CardSlotProps) => {
  const registry = useContext(MarginRegistryContext)!
  const ref = useRef<HTMLDivElement>(null)
  const active = useActiveThread(registry.panelId) === slotKey
  useLayoutEffect(
    () => registry.register(slotKey, {el: ref.current!, blockId, order, quote, trailing}),
    [registry, slotKey, blockId, order, quote, trailing],
  )
  return (
    <div
      ref={ref}
      data-margin-card={slotKey}
      onClick={() => activateThread(registry.panelId, slotKey)}
      onFocus={event => { if (isKeyboardFocus(event)) activateThread(registry.panelId, slotKey) }}
      // Placed by the layout pass; transparent until it has, not hidden: an
      // editor mounting in a new card (a comment just started) takes focus
      // as it mounts, which a hidden element refuses.
      style={{opacity: 0}}
      className={`pointer-events-auto absolute inset-x-0 top-0 rounded-md transition-shadow ${
        active ? 'shadow-md ring-1 ring-ring' : 'shadow-sm'
      }`}
    >
      {children}
    </div>
  )
}

/** Open threads whose rows aren't rendered, as one stub on the nearest row
 *  that is; expanding it brings their rows, and their cards, back. */
const HiddenThreadsStub = ({blockId, count}: {blockId: string; count: number}) => {
  const block = useRepo().block(blockId)
  return (
    <CardSlot slotKey={`hidden:${blockId}`} blockId={blockId} order={0} trailing>
      <button
        type="button"
        onClick={() => { if (block.peekProperty(isCollapsedProp)) void block.set(isCollapsedProp, false) }}
        className="flex w-full items-center gap-1.5 rounded-md border border-dashed bg-background px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <MessageSquare className="h-3 w-3" aria-hidden/>
        {count} thread{count === 1 ? '' : 's'} inside
      </button>
    </CardSlot>
  )
}

interface WidthHandleProps {
  frame: ColumnFrame
  /** A drag asking for `width`; the layout pass bounds it. */
  onDrag: (width: number) => void
  onEnd: () => void
  /** A drag the browser took away: back to the stored width. */
  onCancel: () => void
  onReset: () => void
}

/** In the gap left of the column: drag to set its width, double-click to make
 *  it automatic again. */
const WidthHandle = ({frame, onDrag, onEnd, onCancel, onReset}: WidthHandleProps) => {
  /** `moved`: a press that never moved (a double-click's) sets nothing. */
  const drag = useRef<{x: number; width: number; moved: boolean} | null>(null)
  const finish = (then: () => void) => () => {
    const moved = drag.current?.moved
    drag.current = null
    if (moved) then()
  }
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize comments margin"
      title="Drag to resize; double-click for automatic width"
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault()
        drag.current = {x: event.clientX, width: frame.width, moved: false}
        event.currentTarget.setPointerCapture(event.pointerId)
      }}
      onPointerMove={event => {
        if (!drag.current) return
        const dx = drag.current.x - event.clientX
        if (!drag.current.moved && Math.abs(dx) < DRAG_THRESHOLD_PX) return
        drag.current.moved = true
        onDrag(drag.current.width + dx)
      }}
      onPointerUp={finish(onEnd)}
      onPointerCancel={finish(onCancel)}
      // After a pointerup has finished the drag; this is a capture lost
      // without one.
      onLostPointerCapture={finish(onCancel)}
      onDoubleClick={onReset}
      className="group absolute z-[6] flex cursor-col-resize touch-none justify-center"
      style={{left: frame.left - (EDGE_PX + HANDLE_WIDTH_PX) / 2, top: frame.top, width: HANDLE_WIDTH_PX, height: frame.height}}
    >
      <div className="h-full w-px bg-transparent transition-colors group-hover:bg-border group-active:bg-ring"/>
    </div>
  )
}

/** Floats at the column's foot: closed threads are hidden unless asked for,
 *  and the margin closes from here. */
const MarginFooter = ({panelBlock, hasThreads}: {panelBlock: Block; hasThreads: boolean}) => {
  const panelId = panelBlock.id
  const showClosed = useShowClosed(panelId)
  const buttonClass = 'pointer-events-auto inline-flex items-center gap-1 rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground shadow-sm hover:text-foreground'
  return (
    <div className="pointer-events-none absolute bottom-2 right-1 z-10 flex gap-1">
      {hasThreads && (
        <button type="button" onClick={() => toggleShowClosed(panelId)} className={buttonClass}>
          {showClosed ? 'Hide closed' : 'Show closed'}
        </button>
      )}
      <button
        type="button"
        onClick={() => void panelBlock.set(annotationMarginOpenProp, false)}
        className={buttonClass}
        aria-label="Close comments margin"
        title="Close comments margin"
      >
        <X className="h-3 w-3" aria-hidden/>
      </button>
    </div>
  )
}
