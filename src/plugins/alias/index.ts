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
 * title edit, and `references.renameBacklinks` — same-tx as of #461 —
 * reads it from the staged state later in the same pass. That "later" is
 * not incidental: rename carries an explicit facet precedence
 * (`RENAME_BACKLINKS_PRECEDENCE`) to sort after every default-precedence
 * same-tx processor, this one included. Run it ahead of sync and it finds
 * no alias diff and silently does nothing.
 */
import type { AppExtension } from '@/facets/facet.js'
import { systemToggle } from '@/facets/togglable.js'
import { rejectionToastFacet } from '@/extensions/core.js'
import { aliasDataExtension } from './dataExtension.ts'
import { aliasCollisionRejectionToast } from './rejectionToast.tsx'
import { aliasPageBulletContribution, aliasPageStylingContribution } from './pageStyling.ts'

export const aliasPlugin: AppExtension = systemToggle({
  id: 'system:alias',
  name: 'Aliases',
  description: 'Alias property, sync processor, and page styling so blocks can be referenced by name.',
}).of([
  aliasDataExtension,
  rejectionToastFacet.of(aliasCollisionRejectionToast, {source: 'alias'}),
  aliasPageStylingContribution,
  aliasPageBulletContribution,
])

export { aliasDataExtension } from './dataExtension.ts'
export { ALIAS_COLLISION_MERGE_MUTATOR, aliasCollisionMerge } from './collisionMerge.ts'
export { ALIAS_SYNC_PROCESSOR, aliasSyncProcessor } from './syncProcessor.ts'
export { aliasPageBullet, aliasPageStyling } from './pageStyling.ts'
