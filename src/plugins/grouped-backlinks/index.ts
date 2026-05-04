import {
  BlockChildrenFooterContribution,
  blockChildrenFooterFacet,
} from '@/extensions/blockInteraction.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { GroupedLinkedReferences } from './GroupedLinkedReferences.tsx'
import { groupedBacklinksDataExtension } from './dataExtension.ts'

const groupedLinkedReferencesContribution: BlockChildrenFooterContribution = (context) => {
  if (!context.isTopLevel) return null
  return GroupedLinkedReferences
}

export const groupedBacklinksPlugin: AppExtension = [
  groupedBacklinksDataExtension,
  blockChildrenFooterFacet.of(groupedLinkedReferencesContribution, {source: 'grouped-backlinks'}),
]
