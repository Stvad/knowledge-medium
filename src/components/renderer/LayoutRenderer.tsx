import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { useHandle, usePropertyValue } from '@/hooks/block.ts'
import { useCallback, useEffect, useMemo } from 'react'
import type { BlockData } from '@/data/api'
import type { Block } from '@/data/block.ts'
import { activePanelIdProp } from '@/data/properties.ts'
import {
  isPanelStackRow,
  panelRowsInLayoutOrder,
} from '@/utils/panelLayoutProjection.ts'

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
  className,
  stacked,
  wideScrollSurface,
  trackFocus,
}: {
  slot: Extract<RenderSlot, {kind: 'panel'}>
  layoutSessionBlock: Block
  canClosePanel: boolean
  className: string
  stacked: boolean
  wideScrollSurface: boolean
  trackFocus: boolean
}) {
  const markActivePanel = useCallback(() => {
    if (layoutSessionBlock.peekProperty(activePanelIdProp) === slot.id) return
    void layoutSessionBlock.set(activePanelIdProp, slot.id)
  }, [layoutSessionBlock, slot.id])

  return (
    <NestedBlockContextProvider
      overrides={{layoutBoundary: true, panelId: slot.id, canClosePanel, stackedPanel: stacked, wideScrollSurface}}
      key={slot.id}
    >
      <div
        className={className}
        onPointerDownCapture={markActivePanel}
        onFocusCapture={trackFocus ? markActivePanel : undefined}
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
  topLevel,
  wideScrollSurface,
  trackFocus,
}: {
  slot: RenderSlot
  layoutSessionBlock: Block
  canClosePanel: boolean
  topLevel: boolean
  wideScrollSurface: boolean
  trackFocus: boolean
}) {
  if (slot.kind === 'panel') {
    return <PanelSlotView
      slot={slot}
      layoutSessionBlock={layoutSessionBlock}
      canClosePanel={canClosePanel}
      className={topLevel ? (wideScrollSurface ? WIDE_SCROLL_COLUMN_CLASS : TOP_LEVEL_COLUMN_CLASS) : STACK_CHILD_CLASS}
      stacked={!topLevel}
      wideScrollSurface={wideScrollSurface}
      trackFocus={trackFocus}
    />
  }

  return (
    <div
      key={slot.id}
      className={`${topLevel ? TOP_LEVEL_COLUMN_CLASS : STACK_CHILD_CLASS} flex flex-col gap-2 overflow-y-auto pr-1`}
    >
      {slot.children.map(child => (
        <SlotView
          key={child.id}
          slot={child}
          layoutSessionBlock={layoutSessionBlock}
          canClosePanel={canClosePanel}
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
  const rows = useHandle(block.repo.query.subtree({id: block.id}), {
    selector: data => data ?? EMPTY_ROWS,
  })
  const slots = useMemo(() => buildRenderSlots(block.id, rows), [block.id, rows])
  const panelSlots = useMemo(() => {
    const panelIds = new Set(panelRowsInLayoutOrder(block.id, rows).map(row => row.id))
    return flattenPanelSlots(slots).filter(slot => panelIds.has(slot.id))
  }, [block.id, rows, slots])
  const activePanelSlot = activePanelId
    ? panelSlots.find(slot => slot.id === activePanelId)
    : undefined
  const fallbackActivePanelSlot = isMobile
    ? panelSlots.at(-1)
    : panelSlots[0]
  const mobilePanelSlot = activePanelSlot ?? fallbackActivePanelSlot
  const slotsToRender = isMobile
    ? (mobilePanelSlot ? [mobilePanelSlot] : [])
    : slots
  const canClosePanel = panelSlots.length > 1
  const hasOneVisiblePanel = slotsToRender.length === 1 && slotsToRender[0]?.kind === 'panel'

  useEffect(() => {
    // A panel insert writes activePanelId and the new row in one tx, but
    // React subscriptions can surface the property before this subtree
    // query includes the row. Don't treat "active id not in current rows"
    // as stale here or mobile can immediately hide the newly opened panel.
    if (!fallbackActivePanelSlot || activePanelSlot || activePanelId) return
    void block.set(activePanelIdProp, fallbackActivePanelSlot.id)
  }, [block, activePanelId, activePanelSlot, fallbackActivePanelSlot])

  return <div className="layout flex min-w-0 flex-row flex-grow justify-start overflow-x-auto h-full">
    {slotsToRender.map(slot => (
      <SlotView
        key={slot.id}
        slot={slot}
        layoutSessionBlock={block}
        canClosePanel={canClosePanel}
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
