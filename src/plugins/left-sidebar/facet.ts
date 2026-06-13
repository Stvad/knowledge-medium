import type { ComponentType } from 'react'
import { defineFacet } from '@/facets/facet.js'

export interface LeftSidebarSectionProps {
  closeSidebar: () => void
}

export interface LeftSidebarSectionContribution {
  id: string
  component: ComponentType<LeftSidebarSectionProps>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isLeftSidebarSectionContribution = (
  value: unknown,
): value is LeftSidebarSectionContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.component === 'function'

export const leftSidebarSectionsFacet = defineFacet<
  LeftSidebarSectionContribution,
  readonly LeftSidebarSectionContribution[]
>({
  id: 'left-sidebar.sections',
  validate: isLeftSidebarSectionContribution,
})
