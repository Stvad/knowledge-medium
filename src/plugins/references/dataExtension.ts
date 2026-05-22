import {
  invalidationRulesFacet,
  localSchemaFacet,
  postCommitProcessorsFacet,
} from '@/data/facets.js'
import type { AppExtension } from '@/extensions/facet.js'
import { referencesPostCommitProcessors } from './referencesProcessor.ts'
import { renamePostCommitProcessors } from './renameProcessor.ts'
import { referencesLocalSchema } from './localSchema.ts'
import { referencesInvalidationRule } from './invalidation.ts'

export const referencesDataExtension: AppExtension = [
  localSchemaFacet.of(referencesLocalSchema, {source: 'references'}),
  invalidationRulesFacet.of(referencesInvalidationRule, {source: 'references'}),
  [...referencesPostCommitProcessors, ...renamePostCommitProcessors].map(processor =>
    postCommitProcessorsFacet.of(processor, {source: 'references'}),
  ),
]
