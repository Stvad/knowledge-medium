/**
 * Alias plugin — owns same-block content↔aliases reconciliation.
 *
 * The `aliasDataExtension` (in `dataExtension.ts`) registers the
 * `alias.sync` post-commit processor. Cross-block alias-rename
 * backlink rewriting lives in the references plugin
 * (`@/plugins/references`), which already owns the
 * `block_references` projection needed to find source blocks; the
 * two processors compose via the field-watcher (sync's alias write
 * re-fires the watcher and lets rename act on the swap diff).
 */
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { rejectionToastFacet } from '@/extensions/processorRejectionToast.js'
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
