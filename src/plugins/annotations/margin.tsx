/**
 * The comments margin: a card per thread beside its target row, in a column
 * to the right of the panel's text frame, in document order.
 *
 * A panel mount, so it composes with whatever layout renders the panel, and it
 * uses the width a wide panel leaves empty beside the text instead of
 * squeezing it. The cost is that it lives outside the scrollport: it finds the
 * panel's rows in the DOM (mounted rows and lazy placeholders alike, of the
 * panel's own render scope), reads their positions and moves the cards within
 * one animation frame of a scroll, a resize or a re-render.
 *
 * Where there is no room for the column, it draws nothing and says so
 * (`setMarginShowing`), and the comment pill falls back to expanding threads
 * inline.
 */

import {createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type WheelEvent} from 'react'
import {MessageSquare} from 'lucide-react'
import type {Block} from '@/data/block'
import {activePanelIdProp, isCollapsedProp, topLevelBlockIdProp} from '@/data/properties.js'
import {useLayoutSessionBlock} from '@/data/globalState.js'
import {NestedBlockContextProvider} from '@/context/block.js'
import {useRepo} from '@/context/repo.js'
import {useHandle, usePropertyValue, useWorkspaceId} from '@/hooks/block.js'
import {runActionByIdSafely} from '@/shortcuts/runAction.js'
import {panelRenderScopeId} from '@/utils/renderScope.js'
import {TOGGLE_MARGIN_ACTION_ID} from './actions.ts'
import {OPEN_THREADS_UNDER_QUERY} from './hiddenThreads.ts'
import {annotationMarginOpenProp} from './marginSchema.ts'
import {placeCards} from './placement.ts'
import {THREADS_FOR_BLOCK_QUERY, type ThreadSummary} from './summaries.ts'
import {ThreadCard} from './ui.tsx'
import {
  activateThread,
  onUiStoreChange,
  peekActiveThread,
  setMarginShowing,
  toggleShowClosed,
  useActiveThread,
  useShowClosed,
} from './uiStore.ts'

/** The column's width bounds, and the space kept between it and the text. A
 *  panel with less room than the minimum shows no margin. */
const MIN_COLUMN_PX = 240
const MAX_COLUMN_PX = 340
const EDGE_PX = 16
const CARD_GAP_PX = 8

interface ColumnFrame {
  left: number
  top: number
  width: number
  height: number
}

const sameFrame = (a: ColumnFrame | null, b: ColumnFrame | null): boolean =>
  a === b || (a !== null && b !== null &&
    a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height)

/** Rows of the panel's own outline: shells, and the placeholders of rows not
 *  mounted yet. Rows inside an embed or a backlink entry carry other scopes. */
const rowSelector = (scope: string): string => {
  const s = CSS.escape(scope)
  return `[data-block-shell][data-block-id][data-render-scope-id="${s}"], [data-lazy-block-id][data-lazy-render-scope-id="${s}"]`
}

const rowBlockId = (el: Element): string | null =>
  el.getAttribute('data-block-id') ?? el.getAttribute('data-lazy-block-id')

/** A card slot: where a card registers its element for the layout pass. */
interface CardEntry {
  el: HTMLElement
  blockId: string
  /** Position among its block's cards (whole-block first, then by quote). */
  order: number
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

const MarginColumn = ({panelBlock, topLevelBlockId}: {panelBlock: Block; topLevelBlockId: string}) => {
  const panelId = panelBlock.id
  const scope = panelRenderScopeId(panelId, topLevelBlockId)
  const probeRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const [frame, setFrame] = useState<ColumnFrame | null>(null)
  const [rows, setRows] = useState<readonly string[]>([])
  const cards = useRef(new Map<string, CardEntry>())
  const scheduleRef = useRef<() => void>(() => {})
  const cardObserver = useRef<ResizeObserver | null>(null)

  const [registry] = useState<MarginRegistry>(() => ({
    panelId,
    register: (key, entry) => {
      cards.current.set(key, entry)
      cardObserver.current?.observe(entry.el)
      scheduleRef.current()
      return () => {
        if (cards.current.get(key) === entry) cards.current.delete(key)
        cardObserver.current?.unobserve(entry.el)
        scheduleRef.current()
      }
    },
  }))

  useLayoutEffect(() => {
    const panelEl = probeRef.current?.closest<HTMLElement>('[data-panel-id]')
    const scrollport = panelEl?.querySelector<HTMLElement>('[data-panel-scrollport]')
    if (!panelEl || !scrollport) return
    const selector = rowSelector(scope)
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

    const measure = (top: Element | null): ColumnFrame | null => {
      const panelRect = panelEl.getBoundingClientRect()
      const portRect = scrollport.getBoundingClientRect()
      const textRight = top ? top.getBoundingClientRect().right : portRect.right
      const width = Math.min(MAX_COLUMN_PX, Math.floor(portRect.right - textRight - 2 * EDGE_PX))
      return width < MIN_COLUMN_PX ? null : {
        left: Math.round(textRight - panelRect.left + EDGE_PX),
        top: Math.round(portRect.top - panelRect.top),
        width,
        height: Math.round(portRect.height),
      }
    }

    const run = () => {
      pending = 0
      const topRow = scrollport.querySelector(topRowSelector)
      if (topRow !== observedTopRow) {
        if (observedTopRow) resize.unobserve(observedTopRow)
        if (topRow) resize.observe(topRow)
        observedTopRow = topRow
      }
      const nextFrame = measure(topRow)
      setFrame(current => sameFrame(current, nextFrame) ? current : nextFrame)
      const rowEls = new Map<string, Element>()
      for (const el of scrollport.querySelectorAll(selector)) {
        const id = rowBlockId(el)
        if (id && !rowEls.has(id)) rowEls.set(id, el)
      }
      const order = [...rowEls.keys()]
      setRows(current => current.length === order.length && current.every((id, i) => id === order[i]) ? current : order)
      const column = columnRef.current
      if (!column || !nextFrame) {
        setExtraBottom(0)
        return
      }
      const columnTop = column.getBoundingClientRect().top
      const rowIndex = new Map(order.map((id, i) => [id, i]))
      const placed = [...cards.current.entries()]
        .filter(([, entry]) => rowIndex.has(entry.blockId))
        .sort(([, a], [, b]) => rowIndex.get(a.blockId)! - rowIndex.get(b.blockId)! || a.order - b.order)
      const boxes = placed.map(([, entry]) => ({
        anchor: rowEls.get(entry.blockId)!.getBoundingClientRect().top - columnTop,
        height: entry.el.offsetHeight,
      }))
      const active = peekActiveThread(panelId)
      const focused = placed.findIndex(([key]) => key === active)
      // Pinned only while its row is in view: a card whose text is scrolled
      // away has nothing to stay beside, and pinning it would push the cards
      // that are in view away from theirs.
      const pinned = focused >= 0 && boxes[focused].anchor >= 0 && boxes[focused].anchor < nextFrame.height ? focused : null
      const tops = placeCards(boxes, pinned, CARD_GAP_PX)
      for (const [i, [, entry]] of placed.entries()) {
        entry.el.style.transform = `translateY(${Math.round(tops[i])}px)`
        entry.el.style.visibility = 'visible'
      }
      for (const [, entry] of cards.current) {
        if (!rowIndex.has(entry.blockId)) entry.el.style.visibility = 'hidden'
      }
      const last = tops.length - 1
      const cardsEnd = last < 0 ? 0 : scrollport.scrollTop + tops[last] + boxes[last].height + CARD_GAP_PX
      const contentEnd = scrollport.scrollHeight - extraBottom
      setExtraBottom(Math.max(0, Math.ceil(cardsEnd - contentEnd)))
    }
    const schedule = () => {
      if (!pending) pending = requestAnimationFrame(run)
    }
    scheduleRef.current = schedule

    const resize = new ResizeObserver(schedule)
    resize.observe(panelEl)
    resize.observe(scrollport)
    cardObserver.current = resize
    for (const entry of cards.current.values()) resize.observe(entry.el)
    // Rows mounting or unmounting, which can leave the outline's height as it
    // was (a placeholder swapped for its row).
    const mutations = new MutationObserver(schedule)
    mutations.observe(scrollport, {childList: true, subtree: true})
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
      scheduleRef.current = () => {}
    }
  }, [panelId, scope, topLevelBlockId])

  const showing = frame !== null
  useEffect(() => {
    setMarginShowing(panelId, showing)
    return () => setMarginShowing(panelId, false)
  }, [panelId, showing])

  // The column is outside the scrollport, so a wheel over a card would scroll
  // nothing; hand it to the outline.
  const forwardWheel = (event: WheelEvent) => {
    if (event.ctrlKey) return
    probeRef.current?.closest('[data-panel-id]')?.querySelector('[data-panel-scrollport]')
      ?.scrollBy({top: event.deltaY, left: 0})
  }

  return (
    <>
      <div ref={probeRef} hidden/>
      {frame && (
        <div
          ref={columnRef}
          aria-label="Comments margin"
          role="complementary"
          onWheel={forwardWheel}
          className="pointer-events-none absolute z-[5] overflow-clip"
          style={{left: frame.left, top: frame.top, width: frame.width, height: frame.height}}
        >
          <MarginRegistryContext value={registry}>
            <NestedBlockContextProvider overrides={{layoutBoundary: false, renderScopeId: scope, scopeRootId: topLevelBlockId}}>
              <ShowClosedToggle panelId={panelId} rows={rows}/>
              {rows.map(blockId => (
                <MarginRow key={blockId} blockId={blockId} isTopLevel={blockId === topLevelBlockId}/>
              ))}
            </NestedBlockContextProvider>
          </MarginRegistryContext>
        </div>
      )}
    </>
  )
}

const NO_THREADS: readonly ThreadSummary[] = Object.freeze([])

const useBlockThreads = (blockId: string): readonly ThreadSummary[] => {
  const repo = useRepo()
  const block = repo.block(blockId)
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  return useHandle(repo.query[THREADS_FOR_BLOCK_QUERY]({workspaceId, id: blockId}), {selector: t => t ?? NO_THREADS})
}

const MarginRow = ({blockId, isTopLevel}: {blockId: string; isTopLevel: boolean}) => {
  const registry = useContext(MarginRegistryContext)!
  const threads = useBlockThreads(blockId)
  const showClosed = useShowClosed(registry.panelId)
  const repo = useRepo()
  const [collapsed] = usePropertyValue(repo.block(blockId), isCollapsedProp)
  return (
    <>
      {threads.map((thread, order) => (thread.open || showClosed) && (
        <CardSlot key={thread.id} slotKey={thread.id} blockId={blockId} order={order}>
          <div className={thread.open ? undefined : 'opacity-70'}>
            <ThreadCard thread={thread} surface="margin"/>
          </div>
        </CardSlot>
      ))}
      {/* The focal block's own subtree always renders, collapsed or not. */}
      {collapsed && !isTopLevel && <CollapsedStub blockId={blockId}/>}
    </>
  )
}

const CardSlot = ({slotKey, blockId, order, children}: {slotKey: string; blockId: string; order: number; children: ReactNode}) => {
  const registry = useContext(MarginRegistryContext)!
  const ref = useRef<HTMLDivElement>(null)
  const active = useActiveThread(registry.panelId) === slotKey
  useLayoutEffect(() => registry.register(slotKey, {el: ref.current!, blockId, order}), [registry, slotKey, blockId, order])
  return (
    <div
      ref={ref}
      data-margin-card={slotKey}
      onPointerDownCapture={() => activateThread(registry.panelId, slotKey)}
      onFocusCapture={() => activateThread(registry.panelId, slotKey)}
      // Placed by the layout pass; hidden until it has.
      style={{visibility: 'hidden'}}
      className={`pointer-events-auto absolute inset-x-0 top-0 rounded-md transition-shadow ${
        active ? 'shadow-md ring-1 ring-ring' : 'shadow-sm'
      }`}
    >
      {children}
    </div>
  )
}

/** Threads anchored inside a collapsed block, as one stub on it; expanding
 *  the block brings their rows, and their cards, back. */
const CollapsedStub = ({blockId}: {blockId: string}) => {
  const repo = useRepo()
  const block = repo.block(blockId)
  const workspaceId = useWorkspaceId(block, repo.activeWorkspaceId ?? '')
  const hidden = useHandle(repo.query[OPEN_THREADS_UNDER_QUERY]({workspaceId, id: blockId}), {selector: ids => ids?.length ?? 0})
  if (hidden === 0) return null
  return (
    <CardSlot slotKey={`collapsed:${blockId}`} blockId={blockId} order={Number.MAX_SAFE_INTEGER}>
      <button
        type="button"
        onClick={() => void block.set(isCollapsedProp, false)}
        className="flex w-full items-center gap-1.5 rounded-md border border-dashed bg-background px-2 py-1 text-left text-xs text-muted-foreground hover:text-foreground"
      >
        <MessageSquare className="h-3 w-3" aria-hidden/>
        {hidden} thread{hidden === 1 ? '' : 's'} inside
      </button>
    </CardSlot>
  )
}

/** Floats at the column's foot: closed threads are hidden unless asked for. */
const ShowClosedToggle = ({panelId, rows}: {panelId: string; rows: readonly string[]}) => {
  const showClosed = useShowClosed(panelId)
  if (rows.length === 0) return null
  return (
    <div className="pointer-events-none absolute bottom-2 right-1 z-10">
      <button
        type="button"
        onClick={() => toggleShowClosed(panelId)}
        className="pointer-events-auto rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground shadow-sm hover:text-foreground"
      >
        {showClosed ? 'Hide closed' : 'Show closed'}
      </button>
    </div>
  )
}

// ──── Header item ────

/** Shows and switches the margin of the active panel. */
export function MarginHeaderItem() {
  const layoutSession = useLayoutSessionBlock()
  const [activePanelId] = usePropertyValue(layoutSession, activePanelIdProp)
  return activePanelId ? <MarginToggleButton panelId={activePanelId}/> : null
}

const MarginToggleButton = ({panelId}: {panelId: string}) => {
  const repo = useRepo()
  const [open] = usePropertyValue(repo.block(panelId), annotationMarginOpenProp)
  const label = open ? 'Hide comments margin' : 'Show comments margin'
  return (
    <button
      type="button"
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-sm transition-colors sm:h-8 sm:w-8 ${
        open ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
      }`}
      onClick={event => void runActionByIdSafely(TOGGLE_MARGIN_ACTION_ID, event)}
      title={label}
      aria-label={label}
      aria-pressed={Boolean(open)}
    >
      <MessageSquare className="h-4 w-4"/>
    </button>
  )
}
