import type { BlockResolveContext } from '@/extensions/blockInteraction.js'
import { defineVariantFacet, type Variant } from '@/extensions/variantFacet.js'
import type { ComponentType, ReactNode } from 'react'
import type { BlockRendererProps } from '@/types.js'

export interface BacklinksViewRendererProps extends BlockRendererProps {
  controls?: ReactNode
}

export type BacklinksViewRenderer = ComponentType<BacklinksViewRendererProps>

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
export type BacklinksViewVariant = Variant<BacklinksViewRenderer>

export const backlinksViewFacet = defineVariantFacet<BlockResolveContext, BacklinksViewRenderer>({
  id: 'backlinks-view.variants',
})
