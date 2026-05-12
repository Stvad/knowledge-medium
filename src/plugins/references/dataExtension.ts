import {
  invalidationRulesFacet,
  localSchemaFacet,
  postCommitProcessorsFacet,
} from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { referencesPostCommitProcessors } from './referencesProcessor.ts'
import { referencesLocalSchema } from './localSchema.ts'
import { referencesInvalidationRule } from './invalidation.ts'

export const referencesDataExtension: AppExtension = [
  localSchemaFacet.of(referencesLocalSchema, {source: 'references'}),
  invalidationRulesFacet.of(referencesInvalidationRule, {source: 'references'}),
  referencesPostCommitProcessors.map(processor =>
    postCommitProcessorsFacet.of(processor, {source: 'references'}),
  ),
]
