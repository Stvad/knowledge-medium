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
import type { AppExtension } from '@/extensions/facet.ts'
import { aliasDataExtension } from './dataExtension.ts'

export const aliasPlugin: AppExtension = [aliasDataExtension]

export { aliasDataExtension } from './dataExtension.ts'
export { ALIAS_SYNC_PROCESSOR, aliasSyncProcessor } from './syncProcessor.ts'
