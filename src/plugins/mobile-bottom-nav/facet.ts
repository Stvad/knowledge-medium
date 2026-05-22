import { defineFacet } from '@/extensions/facet.js'
import type { ActionContextType } from '@/shortcuts/types.js'

export interface MobileBottomNavItemContribution {
  id: string
  actionId: string
  /** Disambiguates action lookup when the same `actionId` is registered
   *  in multiple contexts (e.g. `undo` is registered both globally and
   *  in `normal-mode`). Defaults to GLOBAL. */
  context?: ActionContextType
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isMobileBottomNavItemContribution = (
  value: unknown,
): value is MobileBottomNavItemContribution =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.actionId === 'string' &&
  (value.context === undefined || typeof value.context === 'string')

export const mobileBottomNavItemsFacet = defineFacet<
  MobileBottomNavItemContribution,
  readonly MobileBottomNavItemContribution[]
>({
  id: 'mobile-bottom-nav.items',
  validate: isMobileBottomNavItemContribution,
})
