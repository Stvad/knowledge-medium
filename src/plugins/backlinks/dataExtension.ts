import {
  invalidationRulesFacet,
  localSchemaFacet,
  postCommitProcessorsFacet,
  queriesFacet,
} from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { backlinksForBlockQuery } from './query.ts'
import { backlinksPostCommitProcessors } from './referencesProcessor.ts'
import { backlinksLocalSchema } from './localSchema.ts'
import { backlinksInvalidationRule } from './invalidation.ts'

export const backlinksDataExtension: AppExtension = [
  localSchemaFacet.of(backlinksLocalSchema, {source: 'backlinks'}),
  invalidationRulesFacet.of(backlinksInvalidationRule, {source: 'backlinks'}),
  queriesFacet.of(backlinksForBlockQuery, {source: 'backlinks'}),
  backlinksPostCommitProcessors.map(processor =>
    postCommitProcessorsFacet.of(processor, {source: 'backlinks'}),
  ),
]
