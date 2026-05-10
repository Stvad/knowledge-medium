import { BlockComponent } from '@/components/BlockComponent.tsx'
import { BlockRendererProps } from '@/types.ts'
import { NestedBlockContextProvider } from '@/context/block.tsx'
import { useIsMobile } from '@/utils/react.tsx'
import { useHandle } from '@/hooks/block.ts'
import { useMemo } from 'react'
import type { BlockData } from '@/data/api'
import { isPanelStackRow } from '@/utils/panelLayoutProjection.ts'

type RenderSlot =
  | {kind: 'panel'; id: string}
  | {kind: 'stack'; id: string; children: RenderSlot[]}

const EMPTY_ROWS: readonly BlockData[] = Object.freeze([])

const TOP_LEVEL_COLUMN_CLASS =
  'h-full w-full min-w-0 max-w-3xl shrink-0 border-l border-border pl-2 first:border-l-0 first:pl-0 only:mx-auto md:min-w-md md:basis-0 md:grow md:shrink'
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
  canClosePanel,
  className,
  stacked,
}: {
  slot: Extract<RenderSlot, {kind: 'panel'}>
  canClosePanel: boolean
  className: string
  stacked: boolean
}) {
  return (
    <NestedBlockContextProvider
      overrides={{topLevel: true, panelId: slot.id, canClosePanel, stackedPanel: stacked}}
      key={slot.id}
    >
      <div className={className}>
        <BlockComponent blockId={slot.id}/>
      </div>
    </NestedBlockContextProvider>
  )
}

function SlotView({
  slot,
  canClosePanel,
  topLevel,
}: {
  slot: RenderSlot
  canClosePanel: boolean
  topLevel: boolean
}) {
  if (slot.kind === 'panel') {
    return <PanelSlotView
      slot={slot}
      canClosePanel={canClosePanel}
      className={topLevel ? TOP_LEVEL_COLUMN_CLASS : STACK_CHILD_CLASS}
      stacked={!topLevel}
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
          canClosePanel={canClosePanel}
          topLevel={false}
        />
      ))}
    </div>
  )
}

export function LayoutRenderer({block}: BlockRendererProps) {
  const isMobile = useIsMobile()
  const rows = useHandle(block.repo.query.subtree({id: block.id}), {
    selector: data => data ?? EMPTY_ROWS,
  })
  const slots = useMemo(() => buildRenderSlots(block.id, rows), [block.id, rows])
  const panelSlots = useMemo(() => flattenPanelSlots(slots), [slots])
  const slotsToRender = isMobile
    ? panelSlots.slice(-1)
    : slots
  const canClosePanel = panelSlots.length > 1

  return <div className="layout flex min-w-0 flex-row flex-grow justify-start overflow-x-auto h-full">
    {slotsToRender.map(slot => (
      <SlotView
        key={slot.id}
        slot={slot}
        canClosePanel={canClosePanel}
        topLevel
      />
    ))}
  </div>
}

LayoutRenderer.canRender = ({context}: BlockRendererProps) =>
  !!(context && !context.topLevel && !context.panelId)
LayoutRenderer.priority = () => 20
