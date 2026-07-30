import {
  invalidationRulesFacet,
  localSchemaFacet,
  postCommitProcessorsFacet,
  sameTxProcessorsFacet,
} from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { referencesPostCommitProcessors } from './referencesProcessor.ts'
import { renameSameTxProcessors } from './renameProcessor.ts'
import { referencesSameTxProcessors } from './mergeRetargetProcessor.ts'
import { referencesLocalSchema } from './localSchema.ts'
import { referencesInvalidationRule } from './invalidation.ts'

export const referencesDataExtension: AppExtension = [
  localSchemaFacet.of(referencesLocalSchema, {source: 'references'}),
  invalidationRulesFacet.of(referencesInvalidationRule, {source: 'references'}),
  referencesSameTxProcessors.map(processor =>
    sameTxProcessorsFacet.of(processor, {source: 'references'}),
  ),
  referencesPostCommitProcessors.map(processor =>
    postCommitProcessorsFacet.of(processor, {source: 'references'}),
  ),
]

/** `references.renameBacklinks`, registered SEPARATELY because its
 *  same-tx slot has to come after the alias plugin's `alias.sync` —
 *  see the ORDERING note in `renameProcessor.ts`. Same-tx order is
 *  facet insertion order, so this has to be a distinct extension the
 *  composition root can place after `aliasDataExtension`; folding it back
 *  into `referencesDataExtension` would silently stop the rename firing
 *  for the ordinary title-edit gesture.
 *
 *  Anything wiring `referencesDataExtension` + `aliasDataExtension` and
 *  expecting rename to run (including tests) must include this too, in
 *  that position. */
export const referencesRenameDataExtension: AppExtension = [
  renameSameTxProcessors.map(processor =>
    sameTxProcessorsFacet.of(processor, {source: 'references'}),
  ),
]
