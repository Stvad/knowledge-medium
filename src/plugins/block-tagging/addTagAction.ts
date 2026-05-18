import { Tag } from 'lucide-react'
import type { Block } from '@/data/block'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.ts'
import { showError, showSuccess } from '@/utils/toast.ts'
import { openDialog } from '@/utils/dialogs.ts'
import type { GroupedBacklinksGroupHeaderAction } from '@/plugins/grouped-backlinks/facet.ts'
import { AddTagDialog } from './AddTagDialog.tsx'
import { appendTagToBlocks } from './appendTag.ts'

export const ADD_TAG_ACTION_ID = 'block-tagging.add-tag'

/** Shared flow: pick a tag (one dialog per invocation) and append it
 *  to every block in `blocks`. Used by both the NORMAL_MODE
 *  (single-block) and MULTI_SELECT_MODE (whole selection) action
 *  variants — the dialog still opens exactly once regardless of how
 *  many blocks are being tagged. */
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

/** NORMAL_MODE entry point — the focused single block. Lets the
 *  command palette and any future shortcut binding tag the block the
 *  user is currently on without first entering multi-select. */
export const addTagBlockAction: ActionConfig<
  typeof ActionContextTypes.NORMAL_MODE
> = {
  id: ADD_TAG_ACTION_ID,
  description: 'Tag block',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Tag,
  handler: ({block}: BlockShortcutDependencies) => runAddTagFlow([block]),
}

/** MULTI_SELECT_MODE entry point — the whole selection (or whatever
 *  blocks the group-header surface synthesizes as `selectedBlocks`).
 *  Shares the action id with `addTagBlockAction` so callers don't
 *  have to disambiguate; the shortcut system resolves to the right
 *  variant based on the active context. */
export const addTagAction: ActionConfig<
  typeof ActionContextTypes.MULTI_SELECT_MODE
> = {
  id: ADD_TAG_ACTION_ID,
  description: 'Tag selected blocks',
  context: ActionContextTypes.MULTI_SELECT_MODE,
  icon: Tag,
  canRun: ({selectedBlocks}: MultiSelectModeDependencies) =>
    selectedBlocks.length > 0,
  handler: ({selectedBlocks}: MultiSelectModeDependencies) =>
    runAddTagFlow(selectedBlocks),
}

export const addTagGroupHeaderEntry: GroupedBacklinksGroupHeaderAction = {
  actionId: ADD_TAG_ACTION_ID,
}
