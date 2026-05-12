import { AppExtension } from '@/extensions/facet.ts'
import { backlinksViewFacet } from '@/plugins/backlinks-view/facet.ts'
import { defineVariant } from '@/extensions/variantFacet.ts'
import { LinkedReferences } from './LinkedReferences.tsx'
import { backlinksDataExtension } from './dataExtension.ts'

// Show "Linked References" only when the block is the zoom-in target. Roam-
// style: backlinks live with the page you're viewing, not inline beside every
// nested bullet. The top-level gate is enforced by the backlinks-view
// coordinator's footer contribution; this variant always offers itself.
export const backlinksPlugin: AppExtension = [
  backlinksDataExtension,
  backlinksViewFacet.of(
    () => defineVariant('flat', 'Flat', LinkedReferences),
    {source: 'backlinks'},
  ),
]
