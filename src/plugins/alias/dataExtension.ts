import { sameTxProcessorsFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { aliasSameTxProcessors } from './syncProcessor.ts'

export const aliasDataExtension: AppExtension = aliasSameTxProcessors.map(
  processor => sameTxProcessorsFacet.of(processor, {source: 'alias'}),
)
