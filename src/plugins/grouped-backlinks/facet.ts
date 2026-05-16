import type { ComponentType } from 'react'
import type { Block } from '@/data/block'
import { defineFacet } from '@/extensions/facet.ts'
import type { GroupedBacklinkGroup } from './grouping.ts'

export interface GroupedBacklinksGroupHeaderControlProps {
  targetBlock: Block
  group: GroupedBacklinkGroup
  sourceBlocks: readonly Block[]
  workspaceId: string
}

export interface GroupedBacklinksGroupHeaderControl {
  id: string
  component: ComponentType<GroupedBacklinksGroupHeaderControlProps>
}

const isGroupedBacklinksGroupHeaderControl = (
  value: unknown,
): value is GroupedBacklinksGroupHeaderControl =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as GroupedBacklinksGroupHeaderControl).id === 'string' &&
  typeof (value as GroupedBacklinksGroupHeaderControl).component === 'function'

export const groupedBacklinksGroupHeaderControlsFacet = defineFacet<
  GroupedBacklinksGroupHeaderControl,
  readonly GroupedBacklinksGroupHeaderControl[]
>({
  id: 'grouped-backlinks.group-header-controls',
  validate: isGroupedBacklinksGroupHeaderControl,
})
