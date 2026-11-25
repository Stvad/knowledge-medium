import { useContext } from 'react'
import { PropertyFieldRowContext } from '@/context/propertyDisplay'
import type { Block } from '@/data/block'
import { cachedContentDecorator, type BlockContentDecoratorContribution } from '@/extensions/blockInteraction'
import { useHandle } from '@/hooks/block'
import { drawsPropertyRows } from '@/plugins/property-rows/fieldRow'
import type { BlockRenderer } from '@/types'
import { dayReferenceTargetIso, idDayReferenceCandidate } from './dayIdReferenceAdapter'
import { isDayReferenceSchema } from './schema'
import { rescheduleDateButton } from './wikilinkDateDecorator'

function IdReferenceControl({block, Inner, fieldRowId}: {block: Block; Inner: BlockRenderer; fieldRowId: string}) {
  const candidate = useHandle(block, {selector: row => row?.parentId === fieldRowId ? idDayReferenceCandidate(row) : null})
  if (!candidate) return <Inner block={block}/>
  return <DatedReference block={block} Inner={Inner}
    workspaceId={candidate.workspaceId} targetId={candidate.targetId}/>
}

function DatedReference({block, Inner, workspaceId, targetId}: {
  block: Block; Inner: BlockRenderer; workspaceId: string; targetId: string
}) {
  const iso = useHandle(block.repo.block(targetId), {selector: target => dayReferenceTargetIso(target, workspaceId)})
  return iso ? <div className="flex min-w-0 items-baseline">
    {rescheduleDateButton(block)}
    <Inner block={block}/>
  </div> : <Inner block={block}/>
}

function DayIdReferenceControl({block, Inner}: {block: Block; Inner: BlockRenderer}) {
  const field = useContext(PropertyFieldRowContext)
  return field?.schema && isDayReferenceSchema(field.schema) && !block.repo.isReadOnly
    ? <IdReferenceControl block={block} Inner={Inner} fieldRowId={field.id}/>
    : <Inner block={block}/>
}

const decorateDayIdReference = cachedContentDecorator(DayIdReferenceControl, 'DayIdReferenceControl')

export const dayIdReferenceControlContribution: BlockContentDecoratorContribution = context =>
  drawsPropertyRows(context.blockContext) ? decorateDayIdReference : null
