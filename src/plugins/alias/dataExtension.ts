import { mutatorsFacet, sameTxProcessorsFacet } from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { aliasCollisionMutators } from './collisionMerge.ts'
import { aliasSameTxProcessors } from './syncProcessor.ts'

export const aliasDataExtension: AppExtension = [
  aliasSameTxProcessors.map(processor =>
    // Run alias's same-tx sync AFTER references' merge-retarget. Both fire
    // inside a single `core.merge` tx — sync watches the merged block's
    // content/aliases, retarget watches the merge event — and when the
    // merged block also references the merged-away block the two touch the
    // same row, so their relative order changes the persisted result. The
    // pre-glob `staticDataExtensions` list ran references before alias by
    // hand; same-tx contribution order is now alphabetical-by-path
    // (alias < references), so this precedence restores references-first.
    // kernel and references keep the default 0 (kernel-first by core order,
    // references by its alphabetical slot), both ahead of alias.
    sameTxProcessorsFacet.of(processor, {source: 'alias', precedence: 1}),
  ),
  aliasCollisionMutators.map(mutator =>
    mutatorsFacet.of(mutator, {source: 'alias'}),
  ),
]

export default aliasDataExtension
