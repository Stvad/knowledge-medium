import {
  invalidationRulesFacet,
  localSchemaFacet,
  postCommitProcessorsFacet,
  propertySchemasFacet,
  queriesFacet,
} from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { backlinksForBlockQuery } from './query.ts'
import { backlinksPostCommitProcessors } from './referencesProcessor.ts'
import { backlinksLocalSchema } from './localSchema.ts'
import { backlinksInvalidationRule } from './invalidation.ts'
import { backlinksFilterProp } from './filterProperty.ts'

export const backlinksDataExtension: AppExtension = [
  localSchemaFacet.of(backlinksLocalSchema, {source: 'backlinks'}),
  invalidationRulesFacet.of(backlinksInvalidationRule, {source: 'backlinks'}),
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  propertySchemasFacet.of(backlinksFilterProp, {source: 'backlinks'}),
  backlinksPostCommitProcessors.map(processor =>
    postCommitProcessorsFacet.of(processor, {source: 'backlinks'}),
  ),
]
