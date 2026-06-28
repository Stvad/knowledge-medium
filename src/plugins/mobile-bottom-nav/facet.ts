import { dedupById, defineFacet } from '@/facets/facet.js'
import {
  isActionRefContribution,
  type ActionRefContribution,
} from '@/shortcuts/actionRefItems.js'

/** A bottom-nav button — a reference to an action; its icon + label are read
 *  from the resolved action. Shared shape with the keyboard toolbar
 *  ({@link ActionRefContribution}). */
export type MobileBottomNavItemContribution = ActionRefContribution

// Nav items render once per contribution keyed by `id` (MobileBottomNav.tsx)
// — dedup by `id` (last-wins). Keyed by `id`, NOT `actionId`: the same
// `actionId` can legitimately appear under different `id`s/contexts, but a
// duplicate `id` is a double-mount (same id-bearing-render hazard as #64).
export const mobileBottomNavItemsFacet = defineFacet<
  MobileBottomNavItemContribution,
  readonly MobileBottomNavItemContribution[]
>({
  id: 'mobile-bottom-nav.items',
  combine: dedupById('mobile-bottom-nav.items'),
  validate: isActionRefContribution,
})
