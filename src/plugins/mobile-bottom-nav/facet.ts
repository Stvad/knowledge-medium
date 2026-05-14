import { defineFacet } from '@/extensions/facet.ts'

export interface MobileBottomNavItemContribution {
  id: string
  actionId: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isMobileBottomNavItemContribution = (
  value: unknown,
): value is MobileBottomNavItemContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.actionId === 'string'

export const mobileBottomNavItemsFacet = defineFacet<
  MobileBottomNavItemContribution,
  readonly MobileBottomNavItemContribution[]
>({
  id: 'mobile-bottom-nav.items',
  validate: isMobileBottomNavItemContribution,
})
