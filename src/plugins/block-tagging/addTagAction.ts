import { Tag } from 'lucide-react'
import type { Block } from '@/data/block'
import { defineBlocksAction } from '@/shortcuts/utils.js'
import { showError, showSuccess } from '@/utils/toast.js'
import { openDialog } from '@/utils/dialogs.js'
import type { GroupedBacklinksGroupHeaderAction } from '@/plugins/grouped-backlinks/facet.js'
import { AddTagDialog } from './AddTagDialog.tsx'
import { appendTagToBlocks } from './appendTag.ts'

export const ADD_TAG_ACTION_ID = 'block-tagging.add-tag'

/** Pick a tag (one dialog per invocation) and append it to every
 *  block in `blocks`. Used by both context variants — the dialog
 *  opens exactly once regardless of how many blocks are being
 *  tagged. */
const runAddTagFlow = async (blocks: readonly Block[]): Promise<void> => {
  if (blocks.length === 0) return
  const choice = await openDialog(AddTagDialog)
  if (!choice) return
  try {
    const result = await appendTagToBlocks(blocks, choice.tagName)
    if (result.updated > 0) {
      showSuccess(
        `Tagged ${result.updated} block${result.updated === 1 ? '' : 's'} with [[${choice.tagName}]]`,
      )
    } else if (result.alreadyTagged > 0) {
      showError(`Every selected block already carries [[${choice.tagName}]]`)
    } else {
      showError('No blocks were tagged')
    }
  } catch (error) {
    showError(
      error instanceof Error ? error.message : 'Failed to tag blocks',
    )
  }
}

const pair = defineBlocksAction({
  id: ADD_TAG_ACTION_ID,
  icon: Tag,
  blockDescription: 'Tag block',
  blocksDescription: 'Tag selected blocks',
  flow: runAddTagFlow,
})

export const addTagBlockAction = pair.block
export const addTagAction = pair.blocks
export const ADD_TAG_BLOCKS_ACTION_ID = pair.blocks.id

export const addTagGroupHeaderEntry: GroupedBacklinksGroupHeaderAction = {
  actionId: pair.blocks.id,
}
