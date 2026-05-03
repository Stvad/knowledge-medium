import {
  BlockChildrenFooterContribution,
  blockChildrenFooterFacet,
} from '@/extensions/blockInteraction.ts'
import { AppExtension } from '@/extensions/facet.ts'
import { LinkedReferences } from './LinkedReferences.tsx'
import { backlinksDataExtension } from './dataExtension.ts'

// Show "Linked References" only when the block is the zoom-in target. Roam-
// style: backlinks live with the page you're viewing, not inline beside every
// nested bullet.
const linkedReferencesContribution: BlockChildrenFooterContribution = (context) => {
  if (!context.isTopLevel) return null
  return LinkedReferences
}

export const backlinksPlugin: AppExtension = [
  backlinksDataExtension,
  blockChildrenFooterFacet.of(linkedReferencesContribution, {source: 'backlinks'}),
]
