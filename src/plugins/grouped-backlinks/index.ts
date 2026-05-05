import {
  BlockChildrenFooterContribution,
  blockChildrenFooterFacet,
} from '@/extensions/blockInteraction.ts'
import { propertyUiFacet } from '@/data/facets.ts'
import { appEffectsFacet } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { GroupedLinkedReferences } from './GroupedLinkedReferences.tsx'
import { groupedBacklinksDataExtension } from './dataExtension.ts'
import { groupedBacklinksPreferencesEffect } from './preferences.ts'
import { groupedBacklinksDefaultsUi } from './propertyUi.ts'

const groupedLinkedReferencesContribution: BlockChildrenFooterContribution = (context) => {
  if (!context.isTopLevel) return null
  return GroupedLinkedReferences
}

export const groupedBacklinksPlugin: AppExtension = [
  groupedBacklinksDataExtension,
  appEffectsFacet.of(groupedBacklinksPreferencesEffect, {source: 'grouped-backlinks'}),
  propertyUiFacet.of(groupedBacklinksDefaultsUi, {source: 'grouped-backlinks'}),
  blockChildrenFooterFacet.of(groupedLinkedReferencesContribution, {source: 'grouped-backlinks'}),
]
