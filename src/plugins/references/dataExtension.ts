import {
  invalidationRulesFacet,
  localSchemaFacet,
  postCommitProcessorsFacet,
  sameTxProcessorsFacet,
} from '@/data/facets.js'
import type { AppExtension } from '@/facets/facet.js'
import { referencesPostCommitProcessors } from './referencesProcessor.ts'
import {
  RENAME_BACKLINKS_PRECEDENCE,
  renameSameTxProcessors,
} from './renameProcessor.ts'
import { referencesSameTxProcessors } from './mergeRetargetProcessor.ts'
import { referencesLocalSchema } from './localSchema.ts'
import { referencesInvalidationRule } from './invalidation.ts'

export const referencesDataExtension: AppExtension = [
  localSchemaFacet.of(referencesLocalSchema, {source: 'references'}),
  invalidationRulesFacet.of(referencesInvalidationRule, {source: 'references'}),
  referencesSameTxProcessors.map(processor =>
    sameTxProcessorsFacet.of(processor, {source: 'references'}),
  ),
  // The rename rewriter carries an explicit PRECEDENCE rather than riding
  // registration order: it must run after the alias plugin's `alias.sync`,
  // and `alias.sync` is registered from a different extension whose
  // position relative to this one is not ours to control. Ordering by
  // position would mean lifting this one contribution out of the
  // references plugin and placing it by hand in every composition root —
  // which also lifts it out of the plugin's `systemToggle` boundary, so
  // disabling References would leave the rewriter running with
  // `parseReferences` gone (Codex on PR #444). See the ORDERING note in
  // `renameProcessor.ts`.
  renameSameTxProcessors.map(processor =>
    sameTxProcessorsFacet.of(processor, {
      source: 'references',
      precedence: RENAME_BACKLINKS_PRECEDENCE,
    }),
  ),
  referencesPostCommitProcessors.map(processor =>
    postCommitProcessorsFacet.of(processor, {source: 'references'}),
  ),
]
