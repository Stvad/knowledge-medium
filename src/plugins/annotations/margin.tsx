/**
 * The comments margin: a card per thread beside its target row, in a column
 * to the right of the panel's text frame, in document order.
 *
 * A panel mount, so it composes with whatever layout renders the panel. It
 * uses the width a wide panel leaves empty beside the text first, then moves
 * the text left, then narrows it (`fitColumn`, `PANEL_RIGHT_CLEARANCE`), and
 * the panel's buttons move over it (`PANEL_CONTENT_RIGHT_INSET`). Its width is
 * automatic until dragged, and the dragged width is kept on the panel's row as
 * a share of the pane (`annotationMarginShareProp`). It is a navigation lane
 * of its own (`PANEL_LANE_ATTRIBUTE`), each card paired with its row. The cost
 * of placement is measuring the panel's mounted rows and lazy placeholders.
 * The cards share the outline's native scrollport. In document order each
 * card sits by its target (or quoted line) until the preceding card pushes
 * it down. A tall card can scroll inside itself.
 *
 * Where even the narrowed text leaves no room, it draws nothing and says so
 * (`setMarginShowing`), and the comment pill falls back to expanding threads
 * inline.
 */

import {createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type FocusEvent, type ReactNode, type SyntheticEvent} from 'react'
import {createPortal} from 'react-dom'
import {isEqual} from 'lodash-es'
import {MessageSquare, X} from 'lucide-react'
import {EditorView, repositionTooltips} from '@codemirror/view'
import type {Block} from '@/data/block'
import {isCollapsedProp, topLevelBlockIdProp} from '@/data/properties.js'
import {NestedBlockContextProvider, useBlockContext} from '@/context/block.js'
import {PropertyDisplayScopeContext} from '@/context/propertyDisplay.js'
import {NO_PROPERTY_DISPLAY_SCOPE} from '@/data/propertyDisplayMode.js'
import {isInteractiveContentEvent, scopeRowBlockId, scopeRowSelector} from '@/extensions/blockInteraction.js'
import {useRepo} from '@/context/repo.js'
import {useHandle, usePropertyValue, useWorkspaceId} from '@/hooks/block.js'
import {PANEL_CONTENT_RIGHT_INSET, PANEL_RIGHT_CLEARANCE, PANEL_TEXT_MIN_WIDTH_PX} from '@/utils/panelClearance.js'
import {PANEL_LANE_ANCHOR_BLOCK_ATTRIBUTE, PANEL_LANE_ANCHOR_SCOPE_ATTRIBUTE, PANEL_LANE_ATTRIBUTE} from '@/utils/panelLanes.js'
import {DIVIDER_HANDLE_WIDTH_PX, DividerHandle} from '@/components/DividerHandle.js'
import {isEditorElement} from '@/utils/dom.js'
import {panelRenderScopeId} from '@/utils/renderScope.js'
import {annotationMarginOpenProp, annotationMarginShareProp} from './marginSchema.ts'
import {anchorLinkGroups, MarginAnchorLinks} from './marginAnchorLinks.tsx'
import {byPlacement, fitColumn, placeCards} from './placement.ts'
import {quoteTop} from './quotePosition.ts'
import type {RangeAnchor} from './anchor.ts'
import {THREADS_IN_SCOPE_QUERY, type ScopeThread} from './scopeThreads.ts'
import {ThreadCard, useThreadSummaries} from './ui.tsx'
import {
  activateThread,
  deactivateThread,
  onUiStoreChange,
  peekActiveThread,
  takeMarginReveal,
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
const CARD_GAP_PX = 8
/** Kept clear at the column's foot for `MarginFooter`'s buttons. */
const FOOTER_PX = 28
/** The tallest a card's scrolling body grows, set on the column. */
const CARD_MAX_HEIGHT_VAR = '--margin-card-max-height'

interface ColumnFrame {
  /** Position in the scrollable side-content host. */
  left: number
  width: number
  height: number
  /** The pane's width, which a dragged width is stored as a share of. */
  pane: number
  /** How much of the pane's right the text gives up to the column. */
  clearance: number
  /** From the column's right edge to the pane's. */
  rightInset: number
}

/** A frame's width as a share of its pane, to four places: a fraction of a
 *  pixel at any pane width. */
const shareOf = (frame: ColumnFrame): number => Math.round(frame.width / frame.pane * 1e4) / 1e4

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

const MarginColumn = ({panelBlock, topLevelBlockId}: {panelBlock: Block; topLevelBlockId: string}) => {
  const panelId = panelBlock.id
  const [storedShare] = usePropertyValue(panelBlock, annotationMarginShareProp)
  /** The share of the pane the layout pass asks for: the stored one, or a
   *  drag's. */
  const preferredShare = useRef(storedShare)
  const dragStart = useRef({width: 0, pane: 0})
  const scope = panelRenderScopeId(panelId, topLevelBlockId)
  const probeRef = useRef<HTMLDivElement>(null)
  const columnRef = useRef<HTMLDivElement>(null)
  const [anchorLinks, setAnchorLinks] = useState<ReturnType<typeof anchorLinkGroups>>([])
  const [sideContent, setSideContent] = useState<HTMLElement | null>(null)
  const [frame, setFrame] = useState<ColumnFrame | null>(null)
  const [rows, setRows] = useState<readonly string[]>([])
  const cards = useRef(new Map<string, CardEntry>())
  /** The layout pass, bound while the column is mounted: `schedule` runs it
   *  in the next animation frame, `flush` runs it now and returns its frame. */
  const layout = useRef(IDLE_LAYOUT)
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
    const host = scrollport?.querySelector<HTMLElement>(':scope > * > [data-panel-side-content]')
    const textFrame = scrollport?.querySelector<HTMLElement>(':scope > * > [data-panel-text-frame]')
    if (!panelEl || !scrollport || !host || !textFrame) return
    setSideContent(host)
    const selector = scopeRowSelector(scope)
    let pending = 0

    const topRowSelector =
      `[data-block-shell][data-block-id="${CSS.escape(topLevelBlockId)}"][data-render-scope-id="${CSS.escape(scope)}"]`
    /** The focal block's row spans the whole outline, so its size changes
     *  whenever any row's does, an image that finished loading included. It
     *  is re-found each pass, since the row can remount. */
    let observedTopRow: Element | null = null

    const setPanelGeometry = (frame: ColumnFrame | null) => {
      if (frame && frame.clearance > 0) panelEl.style.setProperty(PANEL_RIGHT_CLEARANCE, `${frame.clearance}px`)
      else panelEl.style.removeProperty(PANEL_RIGHT_CLEARANCE)
      if (frame) panelEl.style.setProperty(PANEL_CONTENT_RIGHT_INSET, `${frame.rightInset}px`)
      else panelEl.style.removeProperty(PANEL_CONTENT_RIGHT_INSET)
    }

    /** From the pane's width alone, which the clearance (padding) leaves
     *  as it is, and the text frame's maximum width as the CSS resolves it
     *  (`max-w-3xl` is in rem). */
    const measure = (portRect: DOMRect): ColumnFrame | null => {
      const panelRect = panelEl.getBoundingClientRect()
      const textMax = Number.parseFloat(getComputedStyle(textFrame).maxWidth)
      const fit = fitColumn({
        pane: portRect.width,
        share: preferredShare.current,
        text: {min: PANEL_TEXT_MIN_WIDTH_PX, max: Number.isFinite(textMax) ? textMax : portRect.width},
        column: COLUMN_BOUNDS,
        edge: EDGE_PX,
      })
      if (!fit) return null
      const contentLeft = portRect.left + fit.left
      return {
        left: Math.round(contentLeft - host.getBoundingClientRect().left),
        width: fit.width,
        height: Math.min(window.innerHeight, scrollport.clientHeight - parseFloat(getComputedStyle(scrollport).paddingBottom)),
        pane: Math.floor(portRect.width),
        clearance: fit.clearance,
        rightInset: panelRect.right - contentLeft - fit.width,
      }
    }

    const run = (): ColumnFrame | null => {
      pending = 0
      const topRow = textFrame.querySelector(topRowSelector)
      if (topRow !== observedTopRow) {
        if (observedTopRow) resize.unobserve(observedTopRow)
        if (topRow) resize.observe(topRow)
        observedTopRow = topRow
      }
      const portRect = scrollport.getBoundingClientRect()
      const nextFrame = topRow && measure(portRect)
      setFrame(current => isEqual(current, nextFrame) ? current : nextFrame)
      setPanelGeometry(nextFrame)
      const rowEls = new Map<string, HTMLElement>()
      for (const el of textFrame.querySelectorAll<HTMLElement>(selector)) {
        const id = scopeRowBlockId(el)
        if (id && !rowEls.has(id)) rowEls.set(id, el)
      }
      const order = [...rowEls.keys()]
      setRows(current => isEqual(current, order) ? current : order)
      const column = columnRef.current
      if (!column || !topRow || !nextFrame) return nextFrame
      const left = `${nextFrame.left}px`
      const columnMoved = column.style.left !== left
      column.style.left = left
      column.style.width = `${nextFrame.width}px`
      column.style.setProperty(CARD_MAX_HEIGHT_VAR, `${Math.max(0, nextFrame.height - 2 * CARD_GAP_PX - FOOTER_PX)}px`)
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
      for (const entry of cards.current.values()) entry.el.hidden = !rowIndex.has(entry.blockId)
      const boxes = placed.map(card => ({anchor: card.anchor, height: card.entry.el.offsetHeight}))
      const tops = placeCards(boxes, CARD_GAP_PX)
      const links = anchorLinkGroups(placed, tops, peekActiveThread(panelId))
      setAnchorLinks(current => isEqual(current, links) ? current : links)
      for (const [i, {entry}] of placed.entries()) {
        const transform = `translateY(${Math.round(tops[i])}px)`
        const cardMoved = entry.el.style.transform !== transform
        entry.el.style.transform = transform
        entry.el.style.opacity = ''
        if (cardMoved || columnMoved) {
          for (const editor of entry.el.querySelectorAll<HTMLElement>('.cm-editor')) {
            const view = EditorView.findFromDOM(editor)
            if (view) repositionTooltips(view)
          }
        }
      }
      const last = placed.length - 1
      column.style.minHeight = `${last < 0 ? 0 : Math.ceil(tops[last] + boxes[last].height + FOOTER_PX + CARD_GAP_PX)}px`
      const reveal = placed.find(card => takeMarginReveal(panelId, card.key))
      reveal?.entry.el.scrollIntoView({block: 'nearest', inline: 'nearest'})
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

    // Placement can resize the observed rows as the outline gives up width.
    const resize = new ResizeObserver(schedule)
    resize.observe(panelEl)
    resize.observe(scrollport)
    cardObserver.current = resize
    for (const entry of cards.current.values()) resize.observe(entry.el)
    // Rows mounting or unmounting, which can leave the outline's height as it
    // was (a placeholder swapped for its row), and text changing in place,
    // which can move a quote to another line at the same height.
    const mutations = new MutationObserver(schedule)
    mutations.observe(textFrame, {childList: true, characterData: true, subtree: true})
    const unsubscribe = onUiStoreChange(schedule)
    schedule()
    return () => {
      cancelAnimationFrame(pending)
      resize.disconnect()
      cardObserver.current = null
      mutations.disconnect()
      unsubscribe()
      setPanelGeometry(null)
      layout.current = IDLE_LAYOUT
    }
  }, [panelId, scope, topLevelBlockId, repo])

  const applyStoredShare = () => {
    preferredShare.current = storedShare
    layout.current.schedule()
  }
  useEffect(applyStoredShare, [storedShare])

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

  return (
    <>
      <div ref={probeRef} hidden/>
      {frame && sideContent && createPortal(
        <div
          ref={columnRef}
          aria-label="Comments margin"
          role="complementary"
          {...{[PANEL_LANE_ATTRIBUTE]: 'comments-margin'}}
          className="pointer-events-none relative z-[5]"
          style={{left: frame.left, width: frame.width}}
        >
          <div className="pointer-events-none sticky top-0 z-10" style={{height: frame.height}}>
            <DividerHandle
              label="Resize comments margin"
              title="Drag to resize; double-click for automatic width"
              // Centred in the gap left of the column.
              style={{pointerEvents: 'auto', left: -(EDGE_PX + DIVIDER_HANDLE_WIDTH_PX) / 2, top: 0, height: frame.height}}
              drag={{
                onStart: () => {
                  dragStart.current = {width: frame.width, pane: frame.pane}
                  return true
                },
                // The layout pass bounds the width asked for.
                onMove: dx => {
                  preferredShare.current = (dragStart.current.width - dx) / dragStart.current.pane
                  layout.current.schedule()
                },
                onEnd: () => {
                  const end = layout.current.flush()
                  const share = end ? shareOf(end) : undefined
                  if (share === undefined || share === storedShare) applyStoredShare()
                  else void panelBlock.set(annotationMarginShareProp, share)
                },
                onCancel: applyStoredShare,
              }}
              onReset={() => void panelBlock.set(annotationMarginShareProp, undefined)}
            />
            <MarginFooter panelBlock={panelBlock} hasThreads={scopeThreads.length > 0}/>
          </div>
          <MarginAnchorLinks groups={anchorLinks} width={EDGE_PX}/>
          <MarginRegistryContext value={registry}>
            {/* Comment threads are their own surface: no property rows, whatever the panel's mode. */}
            <PropertyDisplayScopeContext value={NO_PROPERTY_DISPLAY_SCOPE}>
              <NestedBlockContextProvider overrides={{
                layoutBoundary: false,
                renderScopeId: scope,
                scopeRootId: topLevelBlockId,
                editorTooltipParent: document.body,
              }}>
                {loadedThreads?.length === 0 && (
                  <p className="absolute top-0 px-1 pt-1 text-xs text-muted-foreground">No comments here.</p>
                )}
                {hosts.cardRows.map(blockId => <MarginRow key={blockId} blockId={blockId}/>)}
                {[...hosts.stubs].map(([blockId, count]) => <HiddenThreadsStub key={blockId} blockId={blockId} count={count}/>)}
              </NestedBlockContextProvider>
            </PropertyDisplayScopeContext>
          </MarginRegistryContext>
        </div>, sideContent,
      )}
    </>
  )
}

const NO_SCOPE_THREADS: readonly ScopeThread[] = Object.freeze([])

const IDLE_LAYOUT = {schedule: () => {}, flush: (): ColumnFrame | null => null}

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

/** Did the event start inside the element handling it, not in a portal of
 *  one of its descendants? */
const ownEvent = (event: SyntheticEvent<HTMLElement>): boolean =>
  event.currentTarget.contains(event.target as Node)

/** Pointer activation belongs to the click; keyboard focus selects immediately. */
const isKeyboardFocus = (event: FocusEvent): boolean => {
  try {
    return (event.target as Element).matches(':focus-visible')
  } catch {
    return false
  }
}

interface CardSlotProps {
  slotKey: string
  /** A stub expands the outline instead of selecting a thread. */
  activates?: boolean
  blockId: string
  order: number
  quote?: RangeAnchor
  trailing?: boolean
  children: ReactNode
}

const CardSlot = ({slotKey, activates = true, blockId, order, quote, trailing, children}: CardSlotProps) => {
  const registry = useContext(MarginRegistryContext)!
  // The panel's scope, which the column renders in: the scope of the row.
  const {renderScopeId: rowScope} = useBlockContext()
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
      {...{[PANEL_LANE_ANCHOR_BLOCK_ATTRIBUTE]: blockId, [PANEL_LANE_ANCHOR_SCOPE_ATTRIBUTE]: rowScope}}
      // Only for what is in the card itself: a menu portalled out of it
      // reaches these handlers through React too.
      onClickCapture={event => {
        // A block's own click handler can consume a click on its readable text.
        if (activates && ownEvent(event) && !isInteractiveContentEvent(event)) activateThread(registry.panelId, slotKey)
      }}
      onFocus={event => { if (activates && ownEvent(event) && isKeyboardFocus(event)) activateThread(registry.panelId, slotKey) }}
      onKeyDown={event => {
        // Not one a menu or an editor took, where Escape closes that first.
        if (active && event.key === 'Escape' && ownEvent(event) && !event.defaultPrevented &&
          !isEditorElement(event.target as Element)) {
          deactivateThread(registry.panelId)
        }
      }}
      // A new comment's editor can take focus before the first layout pass.
      style={{opacity: 0, scrollMarginBottom: FOOTER_PX}}
      className={`pointer-events-auto absolute inset-x-0 top-0 rounded-md transition-shadow ${
        active ? 'shadow-md ring-1 ring-ring' : 'shadow-sm'
      }`}
    >
      <div
        data-margin-card-body=""
        className="overflow-y-auto overflow-x-hidden rounded-md"
        style={{maxHeight: `var(${CARD_MAX_HEIGHT_VAR})`}}
      >
        {children}
      </div>
      {active && (
        <button
          type="button"
          onClick={event => {
            event.stopPropagation()
            deactivateThread(registry.panelId)
          }}
          className="absolute right-1 top-1 z-10 rounded-full border bg-background p-0.5 text-muted-foreground shadow-sm hover:text-foreground"
          aria-label="Clear comment selection"
          title="Clear comment selection (Esc)"
        >
          <X className="h-3 w-3" aria-hidden/>
        </button>
      )}
    </div>
  )
}

/** Open threads whose rows aren't rendered, as one stub on the nearest row
 *  that is; expanding it brings their rows, and their cards, back. */
const HiddenThreadsStub = ({blockId, count}: {blockId: string; count: number}) => {
  const block = useRepo().block(blockId)
  return (
    <CardSlot slotKey={`hidden:${blockId}`} activates={false} blockId={blockId} order={0} trailing>
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
