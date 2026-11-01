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

import {createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode, type WheelEvent} from 'react'
import {MessageSquare} from 'lucide-react'
import type {Block} from '@/data/block'
import {activePanelIdProp, isCollapsedProp, topLevelBlockIdProp} from '@/data/properties.js'
import {useLayoutSessionBlock} from '@/data/globalState.js'
import {NestedBlockContextProvider} from '@/context/block.js'
import {scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction.js'
import {useRepo} from '@/context/repo.js'
import {useHandle, usePropertyValue, useWorkspaceId} from '@/hooks/block.js'
import {runActionByIdSafely} from '@/shortcuts/runAction.js'
import {panelRenderScopeId} from '@/utils/renderScope.js'
import {TOGGLE_MARGIN_ACTION_ID} from './actions.ts'
import {annotationMarginOpenProp} from './marginSchema.ts'
import {MentionCards} from './mentions.tsx'
import {MENTIONS_FOR_BLOCK_QUERY, type MarginMentions} from './mentionsQuery.ts'
import {placeCards} from './placement.ts'
import {THREADS_IN_SCOPE_QUERY, type ScopeThread} from './scopeThreads.ts'
import {ThreadCard, useThreadSummaries} from './ui.tsx'
import {
  activateThread,
  onUiStoreChange,
  peekActiveThread,
  setMarginShowing,
  toggleShowClosed,
  toggleShowMentions,
  useActiveThread,
  useMarginShowing,
  useShowClosed,
  useShowMentions,
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
  const scrollportRef = useRef<HTMLElement | null>(null)
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

    const measure = (top: Element | null, portRect: DOMRect): ColumnFrame | null => {
      const panelRect = panelEl.getBoundingClientRect()
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
      const portRect = scrollport.getBoundingClientRect()
      const nextFrame = measure(topRow, portRect)
      setFrame(current => sameFrame(current, nextFrame) ? current : nextFrame)
      const rowEls = new Map<string, Element>()
      for (const el of scrollport.querySelectorAll<HTMLElement>(selector)) {
        const id = scopeRowBlockId(el)
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
      const tops = placeCards(boxes, placed.findIndex(([key]) => key === active), CARD_GAP_PX, nextFrame.height)
      for (const [i, [, entry]] of placed.entries()) {
        entry.el.style.transform = `translateY(${Math.round(tops[i])}px)`
        entry.el.style.visibility = 'visible'
      }
      for (const [, entry] of cards.current) {
        if (!rowIndex.has(entry.blockId)) entry.el.style.visibility = 'hidden'
      }
      const last = tops.length - 1
      const cardsEnd = last < 0 ? 0 : scrollport.scrollTop + tops[last] + boxes[last].height + CARD_GAP_PX
      // From the outline itself, not `scrollHeight`: on a page shorter than
      // the viewport that is the viewport's height, so the padding would
      // converge on its size a frame at a time.
      const contentEnd = topRow
        ? topRow.getBoundingClientRect().bottom - portRect.top + scrollport.scrollTop
        : scrollport.scrollHeight - extraBottom
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

  const repo = useRepo()
  const workspaceId = useWorkspaceId(repo.block(topLevelBlockId), repo.activeWorkspaceId ?? '')
  const scopeThreads = useHandle(
    repo.query[THREADS_IN_SCOPE_QUERY]({workspaceId, scopeId: topLevelBlockId}),
    {selector: threads => threads ?? NO_SCOPE_THREADS},
  )
  const showClosed = useShowClosed(panelId)
  const showMentions = useShowMentions(panelId)
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
              <MarginDisplayOptions panelId={panelId} hasThreads={scopeThreads.length > 0}/>
              {hosts.cardRows.map(blockId => <MarginRow key={blockId} blockId={blockId}/>)}
              {showMentions && rows.map(blockId => <MarginMentionsRow key={blockId} blockId={blockId}/>)}
              {[...hosts.stubs].map(([blockId, count]) => <HiddenThreadsStub key={blockId} blockId={blockId} count={count}/>)}
            </NestedBlockContextProvider>
          </MarginRegistryContext>
        </div>
      )}
    </>
  )
}

const NO_SCOPE_THREADS: readonly ScopeThread[] = Object.freeze([])
const NO_MENTIONS: MarginMentions = Object.freeze({ids: [], total: 0})

const MarginMentionsRow = ({blockId}: {blockId: string}) => {
  const repo = useRepo()
  const workspaceId = useWorkspaceId(repo.block(blockId), repo.activeWorkspaceId ?? '')
  const mentions = useHandle(repo.query[MENTIONS_FOR_BLOCK_QUERY]({workspaceId, id: blockId}), {
    selector: result => result ?? NO_MENTIONS,
  })
  if (mentions.ids.length === 0) return null
  return (
    <CardSlot slotKey={`mentions:${blockId}`} blockId={blockId} order={-0.5}>
      <MentionCards blockId={blockId} mentions={mentions}/>
    </CardSlot>
  )
}

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
    <CardSlot key={thread.id} slotKey={thread.id} blockId={blockId} order={order}>
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

const CardSlot = ({slotKey, blockId, order, children}: {slotKey: string; blockId: string; order: number; children: ReactNode}) => {
  const registry = useContext(MarginRegistryContext)!
  const ref = useRef<HTMLDivElement>(null)
  const active = useActiveThread(registry.panelId) === slotKey
  useLayoutEffect(() => registry.register(slotKey, {el: ref.current!, blockId, order}), [registry, slotKey, blockId, order])
  return (
    <div
      ref={ref}
      data-margin-card={slotKey}
      onClick={() => activateThread(registry.panelId, slotKey)}
      onFocus={event => { if (isKeyboardFocus(event)) activateThread(registry.panelId, slotKey) }}
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

/** Open threads whose rows aren't rendered, as one stub on the nearest row
 *  that is; expanding it brings their rows, and their cards, back. */
const HiddenThreadsStub = ({blockId, count}: {blockId: string; count: number}) => {
  const block = useRepo().block(blockId)
  return (
    <CardSlot slotKey={`hidden:${blockId}`} blockId={blockId} order={Number.MAX_SAFE_INTEGER}>
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

/** Per-reader display options, floating at the column's foot. */
const MarginDisplayOptions = ({panelId, hasThreads}: {panelId: string; hasThreads: boolean}) => {
  const showClosed = useShowClosed(panelId)
  const showMentions = useShowMentions(panelId)
  return (
    <div className="pointer-events-none absolute bottom-2 right-1 z-10 flex gap-1">
      <button
        type="button"
        onClick={() => toggleShowMentions(panelId)}
        aria-pressed={showMentions}
        className="pointer-events-auto rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground shadow-sm hover:text-foreground"
      >
        {showMentions ? 'Hide mentions' : 'Show mentions'}
      </button>
      {hasThreads && <button
        type="button"
        onClick={() => toggleShowClosed(panelId)}
        className="pointer-events-auto rounded border bg-background px-1.5 py-0.5 text-xs text-muted-foreground shadow-sm hover:text-foreground"
      >
        {showClosed ? 'Hide closed' : 'Show closed'}
      </button>}
    </div>
  )
}

// ──── Header item ────

/** Shows and switches the margin of the active panel. It reads the session's
 *  pointer where the action resolves the visible pane; the two differ only
 *  while a maximized link is being coerced, which accepts a stale icon. */
export function MarginHeaderItem() {
  const layoutSession = useLayoutSessionBlock()
  const [activePanelId] = usePropertyValue(layoutSession, activePanelIdProp)
  return activePanelId ? <MarginToggleButton panelId={activePanelId}/> : null
}

const MarginToggleButton = ({panelId}: {panelId: string}) => {
  const repo = useRepo()
  const [open] = usePropertyValue(repo.block(panelId), annotationMarginOpenProp)
  const showing = useMarginShowing(panelId)
  const label = !open ? 'Show comments margin'
    : showing ? 'Hide comments margin'
      : 'Hide comments margin (no room for it in this panel)'
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
