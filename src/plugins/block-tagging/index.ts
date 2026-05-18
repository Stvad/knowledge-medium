import { actionsFacet } from '@/extensions/core.ts'
import { propertyEditorOverridesFacet } from '@/data/facets.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { groupedBacklinksGroupHeaderActionsFacet } from '@/plugins/grouped-backlinks/facet.ts'
import { blockTaggingDataExtension } from './dataExtension.ts'
import { blockTagsConfigUi } from './propertyEditorOverride.ts'
import {
  addTagAction,
  addTagBlockAction,
  addTagGroupHeaderEntry,
} from './addTagAction.ts'

export const blockTaggingPlugin: AppExtension = [
  blockTaggingDataExtension,
  propertyEditorOverridesFacet.of(blockTagsConfigUi, {source: 'block-tagging'}),
  actionsFacet.of(addTagBlockAction, {source: 'block-tagging'}),
  actionsFacet.of(addTagAction, {source: 'block-tagging'}),
  groupedBacklinksGroupHeaderActionsFacet.of(
    addTagGroupHeaderEntry,
    {source: 'block-tagging'},
  ),
]

export { blockTagsConfigProp } from './config.ts'
export { ADD_TAG_ACTION_ID, ADD_TAG_BLOCKS_ACTION_ID } from './addTagAction.ts'
export { appendTagToBlocks, appendTagToContent } from './appendTag.ts'
