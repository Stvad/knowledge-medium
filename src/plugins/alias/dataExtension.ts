import { postCommitProcessorsFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { aliasPostCommitProcessors } from './syncProcessor.ts'

export const aliasDataExtension: AppExtension = aliasPostCommitProcessors.map(
  processor => postCommitProcessorsFacet.of(processor, {source: 'alias'}),
)
