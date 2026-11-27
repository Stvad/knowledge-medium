import { useContext } from 'react'
import { PropertyFieldRowContext } from '@/context/propertyDisplay'
import type { Block } from '@/data/block'
import { cachedContentDecorator, type BlockContentDecoratorContribution } from '@/extensions/blockInteraction'
import { useHandle } from '@/hooks/block'
import { drawsPropertyRows } from '@/plugins/property-rows/fieldRow'
import type { BlockRenderer } from '@/types'
import { dayReferenceTargetIso, dayValueReferenceCandidate } from './dayValueReferenceAdapter'
import { singleDateReferenceMatch } from './referenceDateAdapter'
import { isDayReferenceSchema } from './schema'
import { rescheduleDateButton } from './wikilinkDateDecorator'

function ValueReferenceControl({block, Inner, fieldRowId}: {block: Block; Inner: BlockRenderer; fieldRowId: string}) {
  const candidate = useHandle(block, {selector: row => {
    if (row?.parentId !== fieldRowId) return null
    const reference = dayValueReferenceCandidate(row)
    return reference && {...reference, hasDateWikilink: singleDateReferenceMatch(row.content) !== null}
  }})
  if (!candidate) return <Inner block={block}/>
  return <DatedReference block={block} Inner={Inner}
    workspaceId={candidate.workspaceId} targetId={candidate.targetId} hasDateWikilink={candidate.hasDateWikilink}/>
}

function DatedReference({block, Inner, workspaceId, targetId, hasDateWikilink}: {
  block: Block; Inner: BlockRenderer; workspaceId: string; targetId: string; hasDateWikilink: boolean
}) {
  // Warm the target for the adapter even when the wikilink draws its own calendar.
  const iso = useHandle(block.repo.block(targetId), {selector: target => dayReferenceTargetIso(target, workspaceId)})
  return iso && !hasDateWikilink ? <div className="flex min-w-0 items-baseline">
    {rescheduleDateButton(block)}
    <Inner block={block}/>
  </div> : <Inner block={block}/>
}

function DayValueReferenceControl({block, Inner}: {block: Block; Inner: BlockRenderer}) {
  const field = useContext(PropertyFieldRowContext)
  return field?.schema && isDayReferenceSchema(field.schema) && !block.repo.isReadOnly
    ? <ValueReferenceControl block={block} Inner={Inner} fieldRowId={field.id}/>
    : <Inner block={block}/>
}

const decorateDayIdReference = cachedContentDecorator(DayValueReferenceControl, 'DayValueReferenceControl')

export const dayValueReferenceControlContribution: BlockContentDecoratorContribution = context =>
  drawsPropertyRows(context.blockContext) ? decorateDayIdReference : null
