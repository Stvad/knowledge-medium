import type { ComponentType } from 'react'
import { defineFacet } from '@/extensions/facet.ts'

export interface MobileBottomNavItemContribution {
  id: string
  component: ComponentType
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isMobileBottomNavItemContribution = (
  value: unknown,
): value is MobileBottomNavItemContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.component === 'function'

export const mobileBottomNavItemsFacet = defineFacet<
  MobileBottomNavItemContribution,
  readonly MobileBottomNavItemContribution[]
>({
  id: 'mobile-bottom-nav.items',
  validate: isMobileBottomNavItemContribution,
})
