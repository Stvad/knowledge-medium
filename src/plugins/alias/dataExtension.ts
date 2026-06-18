import { mutatorsFacet, sameTxProcessorsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { aliasCollisionMutators } from './collisionMerge.ts'
import { aliasSameTxProcessors } from './syncProcessor.ts'

export const aliasDataExtension: AppExtension = [
  aliasSameTxProcessors.map(processor =>
    sameTxProcessorsFacet.of(processor, {source: 'alias'}),
  ),
  aliasCollisionMutators.map(mutator =>
    mutatorsFacet.of(mutator, {source: 'alias'}),
  ),
]

export default aliasDataExtension
