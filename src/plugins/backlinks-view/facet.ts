import type { BlockResolveContext } from '@/extensions/blockInteraction.ts'
import { defineVariantFacet, type Variant } from '@/extensions/variantFacet.ts'
import type { BlockRenderer } from '@/types.ts'

/**
 * Variant facet for the "Linked References" footer section. The
 * `backlinks-view` coordinator plugin reads this, picks one variant
 * per the user's `backlinks:viewId` preference, and renders that
 * variant's component above a small picker that switches between
 * registered variants.
 *
 * Because only the *selected* variant ever mounts, the unselected
 * view's queries (`useBacklinks`, `useGroupedBacklinks`, …) never
 * subscribe — switching genuinely stops the inactive view's work
 * without any `enabled` plumbing.
 */
export type BacklinksViewVariant = Variant<BlockRenderer>

export const backlinksViewFacet = defineVariantFacet<BlockResolveContext, BlockRenderer>({
  id: 'backlinks-view.variants',
})
