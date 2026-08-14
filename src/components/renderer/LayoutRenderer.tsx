import { BlockComponent } from '@/components/BlockComponent.js'
import { BlockRendererProps } from '@/types.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { useIsMobile } from '@/utils/react.js'
import { isMobileViewport } from '@/utils/viewport.js'
import { useHandle } from '@/hooks/block.js'
import { useEffect, useMemo } from 'react'
import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block.js'
import { activePanelIdProp, isPanelRowMaximized } from '@/data/properties.js'
import {
  allPanelRowsInLayoutOrder,
  isPanelStackRow,
  maximizeWouldHideSomething,
  sessionActivePanelId,
  soloPanelRow,
} from '@/utils/panelLayoutProjection.js'

type RenderSlot =
  | {kind: 'panel'; id: string; maximized: boolean}
  | {kind: 'stack'; id: string; children: RenderSlot[]
      /** Kept only to preserve the solo pane's React parent — see
       *  `soloSlotPath`. Renders no box and defers to its single child. */
      soloWrapper?: true}

const EMPTY_ROWS: readonly BlockData[] = Object.freeze([])

const TOP_LEVEL_COLUMN_CLASS =
  'h-full w-full min-w-0 max-w-3xl shrink-0 border-l border-border pl-2 first:border-l-0 first:pl-0 only:mx-auto md:min-w-md md:basis-0 md:grow md:shrink'
const WIDE_SCROLL_COLUMN_CLASS =
  'h-full w-full min-w-0 shrink-0 border-l border-border pl-2 first:border-l-0 first:pl-0'
const STACK_CHILD_CLASS =
  'w-full min-w-0 shrink-0 border-t border-border pt-2 first:border-t-0 first:pt-0'

const buildRenderSlots = (rootId: string, rows: readonly BlockData[]): RenderSlot[] => {
  const childrenByParent = new Map<string, BlockData[]>()
  for (const row of rows) {
    if (!row.parentId) continue
    const children = childrenByParent.get(row.parentId) ?? []
    children.push(row)
    childrenByParent.set(row.parentId, children)
  }

  const visit = (row: BlockData): RenderSlot => {
    if (isPanelStackRow(row)) {
      return {
        kind: 'stack',
        id: row.id,
        children: (childrenByParent.get(row.id) ?? []).map(visit),
      }
    }
    // Stamped here, where `visit` already holds the row — the alternative is a
    // second pass building an id→row Map the walk just threw away.
    return {kind: 'panel', id: row.id, maximized: isPanelRowMaximized(row)}
  }

  return (childrenByParent.get(rootId) ?? []).map(visit)
}

const flattenPanelSlots = (slots: readonly RenderSlot[]): Array<Extract<RenderSlot, {kind: 'panel'}>> =>
  slots.flatMap(slot => slot.kind === 'panel' ? [slot] : flattenPanelSlots(slot.children))

/**
 * The PATH down to `soloId` — the pane still wrapped in whatever stack it
 * lives in — with every sibling branch dropped.
 *
 * Narrowing to one pane must not HOIST it. React identity is parent + key, so
 * lifting a stacked pane to the top level unmounts and remounts it: local
 * editor state is lost and a playing video restarts, which is a poor trade for
 * a gesture whose whole point is to look at that pane. Keeping the wrapper
 * keeps the component's position in the tree, and keyed reconciliation
 * preserves it even though its stack now renders one child instead of several.
 *
 * Siblings are still dropped rather than hidden with CSS: an off-screen pane
 * that stays mounted keeps running effects and playing audio.
 *
 * `soloId` comes from this same slot tree, so it always resolves — an empty
 * result is unreachable, not a case to fall back from.
 */
const soloSlotPath = (slots: readonly RenderSlot[], soloId: string): RenderSlot[] => {
  for (const slot of slots) {
    if (slot.kind === 'panel') {
      if (slot.id === soloId) return [slot]
      continue
    }
    const inner = soloSlotPath(slot.children, soloId)
    if (inner.length > 0) return [{...slot, children: inner, soloWrapper: true}]
  }
  return []
}

function PanelSlotView({
  slot,
  layoutSessionBlock,
  canClosePanel,
  canMaximizePanel,
  className,
  stacked,
  wideScrollSurface,
  trackFocus,
  columnId,
}: {
  slot: Extract<RenderSlot, {kind: 'panel'}>
  layoutSessionBlock: Block
  canClosePanel: boolean
  canMaximizePanel: boolean
  className: string
  stacked: boolean
  wideScrollSurface: boolean
  trackFocus: boolean
  // `data-layout-column-id` only goes on the *outer* column wrapper.
  // When a panel sits at the top level, this slot IS the column and
  // tags itself. When stacked inside another column, the parent stack
  // div carries the column attribute and this child must omit it.
  columnId?: string
}) {
  return (
    <NestedBlockContextProvider
      overrides={{
        layoutBoundary: true,
        panelId: slot.id,
        layoutSessionBlockId: layoutSessionBlock.id,
        canClosePanel,
        canMaximizePanel,
        stackedPanel: stacked,
        wideScrollSurface,
        trackPanelFocus: trackFocus,
      }}
      key={slot.id}
    >
      <div
        data-layout-column-id={columnId}
        className={className}
      >
        <BlockComponent blockId={slot.id}/>
      </div>
    </NestedBlockContextProvider>
  )
}

function SlotView({
  slot,
  layoutSessionBlock,
  canClosePanel,
  canMaximizePanel,
  topLevel,
  wideScrollSurface,
  trackFocus,
}: {
  slot: RenderSlot
  layoutSessionBlock: Block
  canClosePanel: boolean
  canMaximizePanel: boolean
  topLevel: boolean
  wideScrollSurface: boolean
  trackFocus: boolean
}) {
  if (slot.kind === 'panel') {
    return <PanelSlotView
      slot={slot}
      layoutSessionBlock={layoutSessionBlock}
      canClosePanel={canClosePanel}
      canMaximizePanel={canMaximizePanel}
      className={topLevel ? (wideScrollSurface ? WIDE_SCROLL_COLUMN_CLASS : TOP_LEVEL_COLUMN_CLASS) : STACK_CHILD_CLASS}
      stacked={!topLevel}
      wideScrollSurface={wideScrollSurface}
      trackFocus={trackFocus}
      columnId={topLevel ? slot.id : undefined}
    />
  }

  // A stack kept ONLY to preserve the solo pane's React parent generates no box
  // and hands its column role to that child, which then renders exactly as the
  // top-level pane it visually is — `stackedPanel: false` included. That last
  // part is load-bearing rather than cosmetic: `PanelRenderer` recomputes
  // `wideScrollSurface && !stackedPanel`, so a pane still told it is stacked
  // gets narrow chrome AND no scrollport of its own (its real stack, the thing
  // that used to scroll it, is no longer rendering a box).
  //
  // The wrapper must stay a <div> whose CLASS changes. Returning a Fragment
  // instead would change the element type at this position and remount the very
  // pane this whole path exists to preserve — the same trap `PanelRenderer`
  // documents on its own content frame, solved the same way.
  const soloWrapper = slot.soloWrapper === true
  return (
    <div
      key={slot.id}
      // Handed to the child along with the column role, so spatial navigation
      // still sees exactly one `[data-layout-column-id]` box for this column.
      data-layout-column-id={topLevel && !soloWrapper ? slot.id : undefined}
      className={soloWrapper
        ? 'contents'
        : `${topLevel ? TOP_LEVEL_COLUMN_CLASS : STACK_CHILD_CLASS} flex flex-col gap-2 overflow-y-auto pr-1`}
    >
      {slot.children.map(child => (
        <SlotView
          key={child.id}
          slot={child}
          layoutSessionBlock={layoutSessionBlock}
          canClosePanel={canClosePanel}
          canMaximizePanel={canMaximizePanel}
          topLevel={soloWrapper ? topLevel : false}
          wideScrollSurface={soloWrapper ? wideScrollSurface : false}
          trackFocus={trackFocus}
        />
      ))}
    </div>
  )
}

export function LayoutRenderer({block}: BlockRendererProps) {
  // Subscribed for re-renders, but NOT used as the answer: react-use's
  // `useMedia` returns the supplied default (`false`) on its first render and
  // corrects in an effect, so a phone opening a `;max` link would spend one
  // commit believing it is desktop — long enough for the coercion effect below
  // to fire and make the flagged pane active, which is exactly what mobile
  // must not do. The synchronous media read is right on every render.
  useIsMobile()
  const isMobile = isMobileViewport()
  const rows = useHandle(block.repo.query.subtree({id: block.id, hidePropertyChildren: true}), {
    selector: data => data ?? EMPTY_ROWS,
  })
  // From the ROWS snapshot, never a separate subscription — the effect below
  // compares this pointer against the flags, and both must come from the same
  // commit. See `sessionActivePanelId`.
  const activePanelId = sessionActivePanelId(rows.find(row => row.id === block.id))
  const slots = useMemo(() => buildRenderSlots(block.id, rows), [block.id, rows])
  const panelSlots = useMemo(() => flattenPanelSlots(slots), [slots])
  // Does one pane take the whole layout over? The rule is `soloPanelRow` —
  // shared with navigation, so "which pane the user sees" has exactly one
  // answer. Both narrowing paths this used to spell out (mobile-by-active,
  // desktop-by-flag) live there.
  const soloPanelSlot = useMemo(() => {
    const solo = soloPanelRow(allPanelRowsInLayoutOrder(block.id, rows), {
      activePanelId,
      canRenderSplit: !isMobile,
    })
    return solo ? panelSlots.find(slot => slot.id === solo.id) : undefined
  }, [block.id, rows, panelSlots, activePanelId, isMobile])
  // Only the desktop no-solo case renders the full tree; a solo pane renders
  // alone — but IN PLACE (`soloSlotPath`), so a stacked pane keeps its parent.
  const slotsToRender = useMemo(
    () => soloPanelSlot ? soloSlotPath(slots, soloPanelSlot.id) : (isMobile ? [] : slots),
    [slots, soloPanelSlot, isMobile],
  )
  const canClosePanel = panelSlots.length > 1
  const canMaximizePanel = maximizeWouldHideSomething(panelSlots.length, !isMobile)
  // Counted over the panes actually RENDERED, at any depth: a solo pane is the
  // only thing on screen whether or not a stack wrapper survives around it, and
  // it should get the same wide surface either way. Reading the top-level slot
  // kind instead made a maximized stacked pane keep a `max-w-3xl` column.
  const hasOneVisiblePanel = flattenPanelSlots(slotsToRender).length === 1

  // ── The single writer of `activePanelIdProp` from this renderer ──
  // Two rules, in priority order, deliberately resolved BEFORE the effect
  // rather than in two effects:
  //
  //  1. A SOLO pane must be the active pane, or keyboard dispatch targets a
  //     pane the user cannot see (design §4.4). `togglePanelMaximized` covers
  //     the gesture; this covers arrivals with no gesture at all — Back/Forward,
  //     a shared `;max` link, a snapshot apply — where `reconcilePanelRows`
  //     sets the row flag and leaves the pointer alone. On mobile the solo pane
  //     IS the active pane whenever the pointer is set, so this self-satisfies
  //     and only seeds an unset pointer.
  //  2. Otherwise, seed an unset pointer with the first pane.
  //
  // As two effects both fired in the same commit whenever the pointer was
  // unset — which IS the shared-`;max`-link shape — and disagreed, so the
  // pointer transiently named an unrendered pane (exactly what rule 1 exists
  // to prevent) and took several synced writes, each projecting a replace, to
  // settle.
  //
  // Rule 2 fires only on an ABSENT pointer, never on one that merely names a
  // row this session doesn't have: that row may simply not be projected into
  // this subtree yet, and seizing it would move the user's active pane — on
  // mobile, visibly. Row deletion has its own repair
  // (`activePanelIdAfterReconcile`), so nothing depends on this path to clean
  // up a dangling pointer.
  //
  // Only a DESKTOP solo (a maximize flag) coerces an already-set pointer. The
  // mobile solo is DERIVED from that pointer, so treating it as rule 1 would
  // overwrite a pointer that merely names a row this snapshot doesn't carry
  // yet — with the fallback pane, permanently — which is the opposite of the
  // rule above.
  const desiredActivePanelSlot = (isMobile ? undefined : soloPanelSlot)
    ?? (activePanelId ? undefined : soloPanelSlot ?? panelSlots[0])

  useEffect(() => {
    if (!desiredActivePanelSlot || activePanelId === desiredActivePanelSlot.id) return
    void block.set(activePanelIdProp, desiredActivePanelSlot.id)
  }, [block, activePanelId, desiredActivePanelSlot])

  return <div
    data-layout-session-id={block.id}
    className="layout flex min-w-0 flex-row flex-grow justify-start overflow-x-auto h-full"
  >
    {slotsToRender.map(slot => (
      <SlotView
        key={slot.id}
        slot={slot}
        layoutSessionBlock={block}
        canClosePanel={canClosePanel}
        canMaximizePanel={canMaximizePanel}
        topLevel
        wideScrollSurface={hasOneVisiblePanel}
        trackFocus={!isMobile}
      />
    ))}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.layoutBoundary && !context.panelId)
LayoutRenderer.priority = () => 20
