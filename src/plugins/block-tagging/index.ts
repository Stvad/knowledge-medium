import { actionsFacet } from '@/extensions/core.ts'
import { propertyEditorOverridesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { dialogAppMountExtension } from '@/extensions/dialogAppMount.tsx'
import { systemToggle } from '@/extensions/togglable.ts'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.ts'
import { blockTaggingDataExtension } from './dataExtension.ts'
import { blockTagsConfigUi } from './propertyEditorOverride.ts'
import {
  addTagAction,
  addTagBlockAction,
  addTagGroupHeaderEntry,
} from './addTagAction.ts'

// The plugin's addTagAction calls `openDialog(AddTagDialog)`, which is
// inert without DialogHost mounted. Pull the dialog-mount extension in
// here instead of relying on a top-level "Dialogs" toggle: the
// resolver dedupes by FacetContribution reference, so importing the
// same `dialogAppMountExtension` from every dialog-using plugin still
// registers exactly one appMountsFacet contribution.
export const blockTaggingPlugin: AppExtension = systemToggle({
  id: 'system:block-tagging',
  name: 'Block tagging',
  description: 'Add-tag action and the per-workspace tag-list preference.',
}).of([
  blockTaggingDataExtension,
  dialogAppMountExtension,
  propertyEditorOverridesFacet.of(blockTagsConfigUi, {source: 'block-tagging'}),
  actionsFacet.of(addTagBlockAction, {source: 'block-tagging'}),
  actionsFacet.of(addTagAction, {source: 'block-tagging'}),
  groupedBacklinksGroupHeaderActionsFacet.of(
    addTagGroupHeaderEntry,
    {source: 'block-tagging'},
  ),
])

export { blockTagsConfigProp } from './config.ts'
export { ADD_TAG_ACTION_ID, ADD_TAG_BLOCKS_ACTION_ID } from './addTagAction.ts'
export { appendTagToBlocks, appendTagToContent } from './appendTag.ts'
