import type { ComponentType } from 'react'
import { dedupById, defineFacet } from '@/facets/facet.js'

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

// Sections render once per contribution keyed by `id` (LeftSidebar.tsx) —
// dedup by id (last-wins) so a logical duplicate can't double-mount. Same
// id-bearing-render-facet hazard as `appMountsFacet` (#64).
export const leftSidebarSectionsFacet = defineFacet<
  LeftSidebarSectionContribution,
  readonly LeftSidebarSectionContribution[]
>({
  id: 'left-sidebar.sections',
  combine: dedupById('left-sidebar.sections'),
  validate: isLeftSidebarSectionContribution,
})
