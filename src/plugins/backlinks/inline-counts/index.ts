import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import {
  blockChildrenFooterFacet,
  blockContentDecoratorsFacet,
} from '@/extensions/blockInteraction.js'
import {
  inlineBacklinkCountDecoratorContribution,
  inlineBacklinkExpansionFooterContribution,
} from './InlineBacklinkCount.tsx'

const SOURCE = 'backlinks-inline-counts'

/** Nested sub-toggle under the Backlinks plugin (default on). Shows a
 *  reference-count badge on every ordinary outline block, not just the
 *  focused one; clicking it expands that block's linked references inline.
 *  Disabling it removes both facet contributions entirely — so when off,
 *  no block runs a backlink count. */
export const inlineBacklinkCountsExtension: AppExtension = systemToggle({
  id: 'system:backlinks/inline-counts',
  name: 'Inline backlink counts',
  description:
    'Show a reference-count badge on every block (not just the focused one); click it to expand that block’s linked references inline.',
}).of([
  blockContentDecoratorsFacet.of(inlineBacklinkCountDecoratorContribution, { source: SOURCE }),
  blockChildrenFooterFacet.of(inlineBacklinkExpansionFooterContribution, { source: SOURCE }),
])
