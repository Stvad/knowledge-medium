/**
 * Alias plugin — owns same-block content↔aliases reconciliation.
 *
 * The `aliasDataExtension` (in `dataExtension.ts`) registers the
 * `alias.sync` SAME-TX processor. Cross-block alias-rename backlink
 * rewriting lives in the references plugin (`@/plugins/references`),
 * which already owns the `block_references` projection needed to find
 * source blocks.
 *
 * The two compose inside ONE commit: sync writes the alias diff for a
 * title edit, and `references.renameBacklinks` — same-tx as of #461, and
 * registered immediately AFTER this plugin for exactly that reason —
 * reads it from the staged state in the same pass. Registering rename
 * ahead of sync would leave it with no diff to act on.
 */
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { rejectionToastFacet } from '@/extensions/core.js'
import { aliasDataExtension } from './dataExtension.ts'
import { aliasCollisionRejectionToast } from './rejectionToast.tsx'

export const aliasPlugin: AppExtension = systemToggle({
  id: 'system:alias',
  name: 'Aliases',
  description: 'Alias property + sync processor so blocks can be referenced by name.',
}).of([
  aliasDataExtension,
  rejectionToastFacet.of(aliasCollisionRejectionToast, {source: 'alias'}),
])

export { aliasDataExtension } from './dataExtension.ts'
export { ALIAS_COLLISION_MERGE_MUTATOR, aliasCollisionMerge } from './collisionMerge.ts'
export { ALIAS_SYNC_PROCESSOR, aliasSyncProcessor } from './syncProcessor.ts'
