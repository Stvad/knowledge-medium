import { BlockComponent } from '@/components/BlockComponent.js'
import { BlockRendererProps } from '@/types.js'
import { NestedBlockContextProvider } from '@/context/block.js'
import { useIsMobile } from '@/utils/react.js'
import { useHandle, usePropertyValue } from '@/hooks/block.js'
import { useEffect, useMemo } from 'react'
import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block.js'
import { activePanelIdProp } from '@/data/properties.js'
import { isPanelRowMaximized, isPanelStackRow } from '@/utils/panelLayoutProjection.js'

type RenderSlot =
  | {kind: 'panel'; id: string}
  | {kind: 'stack'; id: string; children: RenderSlot[]}

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
    return {kind: 'panel', id: row.id}
  }

  return (childrenByParent.get(rootId) ?? []).map(visit)
}

const flattenPanelSlots = (slots: readonly RenderSlot[]): Array<Extract<RenderSlot, {kind: 'panel'}>> =>
  slots.flatMap(slot => slot.kind === 'panel' ? [slot] : flattenPanelSlots(slot.children))

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

  return (
    <div
      key={slot.id}
      data-layout-column-id={topLevel ? slot.id : undefined}
      className={`${topLevel ? TOP_LEVEL_COLUMN_CLASS : STACK_CHILD_CLASS} flex flex-col gap-2 overflow-y-auto pr-1`}
    >
      {slot.children.map(child => (
        <SlotView
          key={child.id}
          slot={child}
          layoutSessionBlock={layoutSessionBlock}
          canClosePanel={canClosePanel}
          canMaximizePanel={canMaximizePanel}
          topLevel={false}
          wideScrollSurface={false}
          trackFocus={trackFocus}
        />
      ))}
    </div>
  )
}

export function LayoutRenderer({block}: BlockRendererProps) {
  const isMobile = useIsMobile()
  const [activePanelId] = usePropertyValue(block, activePanelIdProp)
  const rows = useHandle(block.repo.query.subtree({id: block.id, hidePropertyChildren: true}), {
    selector: data => data ?? EMPTY_ROWS,
  })
  const slots = useMemo(() => buildRenderSlots(block.id, rows), [block.id, rows])
  const panelSlots = useMemo(() => flattenPanelSlots(slots), [slots])
  const activePanelSlot = activePanelId
    ? panelSlots.find(slot => slot.id === activePanelId)
    : undefined
  // Desktop analog of the mobile single-pane path: a maximized leaf renders
  // ALONE. Sibling rows are untouched in the substrate, so un-maximizing
  // restores the exact arrangement. First flagged row wins — reconcile writes
  // whatever the hash says, and a multi-`max` hash can only be hand-crafted
  // (see `panelMaximizedProp`). Ignored on mobile: already single-pane.
  const maximizedPanelSlot = useMemo(() => {
    if (isMobile) return undefined
    const rowsById = new Map(rows.map(row => [row.id, row]))
    return panelSlots.find(slot => isPanelRowMaximized(rowsById.get(slot.id)))
  }, [isMobile, panelSlots, rows])
  const fallbackActivePanelSlot = isMobile ? panelSlots.at(-1) : panelSlots[0]
  const mobilePanelSlot = activePanelSlot ?? fallbackActivePanelSlot
  const slotsToRender = isMobile
    ? (mobilePanelSlot ? [mobilePanelSlot] : [])
    : (maximizedPanelSlot ? [maximizedPanelSlot] : slots)
  const canClosePanel = panelSlots.length > 1
  // Maximize hides siblings, so it only means something on a desktop split.
  const canMaximizePanel = !isMobile && panelSlots.length > 1
  const hasOneVisiblePanel = slotsToRender.length === 1 && slotsToRender[0]?.kind === 'panel'

  // ── The single writer of `activePanelIdProp` from this renderer ──
  // Two rules, in priority order, deliberately resolved BEFORE the effect
  // rather than in two effects:
  //
  //  1. A maximized pane must be the active pane. It is the only pane
  //     rendered, so otherwise keyboard dispatch targets a pane the user
  //     cannot see (design §4.4). `togglePanelMaximized` covers the gesture;
  //     this covers arrivals with no gesture at all — Back/Forward, a shared
  //     `;max` link, a snapshot apply — where `reconcilePanelRows` sets the
  //     row flag and leaves the pointer alone.
  //  2. Otherwise, seed an unset pointer with the fallback pane.
  //
  // As two effects both fired in the same commit whenever the pointer was
  // unset — which IS the shared-`;max`-link shape — and disagreed: rule 2
  // seeded `panelSlots[0]` while rule 1 corrected to the maximized pane, so
  // the pointer transiently named an unrendered pane (exactly what rule 1
  // exists to prevent) and took several synced writes, each projecting a
  // replace, to settle.
  //
  // Rule 2 keeps its original "pointer set at all" guard: a panel insert
  // writes `activePanelId` and the new row in one tx, but React subscriptions
  // can surface the property before this subtree query includes the row —
  // treating "active id not in current rows" as stale here would let mobile
  // immediately hide the newly opened panel.
  const desiredActivePanelSlot = maximizedPanelSlot
    ?? (activePanelId || activePanelSlot ? undefined : fallbackActivePanelSlot)

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
        wideScrollSurface={hasOneVisiblePanel && slot.kind === 'panel'}
        trackFocus={!isMobile}
      />
    ))}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.layoutBoundary && !context.panelId)
LayoutRenderer.priority = () => 20
