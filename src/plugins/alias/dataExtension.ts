import { sameTxProcessorsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/extensions/facet.js'
import { aliasSameTxProcessors } from './syncProcessor.ts'

export const aliasDataExtension: AppExtension = aliasSameTxProcessors.map(
  processor => sameTxProcessorsFacet.of(processor, {source: 'alias'}),
)
