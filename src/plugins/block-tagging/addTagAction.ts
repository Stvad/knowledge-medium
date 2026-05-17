import { Tag } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type MultiSelectModeDependencies,
} from '@/shortcuts/types.ts'
import { showError, showSuccess } from '@/utils/toast.ts'
import { openDialog } from '@/utils/dialogs.ts'
import type { GroupedBacklinksGroupHeaderAction } from '@/plugins/grouped-backlinks/facet.ts'
import { AddTagDialog } from './AddTagDialog.tsx'
import { appendTagToBlocks } from './appendTag.ts'

export const ADD_TAG_ACTION_ID = 'block-tagging.add-tag'

/** Append a `[[name]]` reference to every block in
 *  `selectedBlocks`. Opens a picker so the user can choose from the
 *  configured tag list (workspace-scoped, stored under
 *  `blockTagging:tagsConfig` on the user-prefs block) or type a one-off
 *  name. Blocks that already carry the tag are skipped.
 *
 *  Why a picker rather than per-tag buttons: keeping the surface as a
 *  single ActionConfig means tagging works the same from the command
 *  palette, real multi-select, and the grouped-backlinks header
 *  without any dynamic-facet plumbing. The user picks once per
 *  invocation — cheap for the common case where the configured list
 *  is short. */
export const addTagAction: ActionConfig<
  typeof ActionContextTypes.MULTI_SELECT_MODE
> = {
  id: ADD_TAG_ACTION_ID,
  description: 'Tag selected blocks',
  context: ActionContextTypes.MULTI_SELECT_MODE,
  icon: Tag,
  canRun: ({selectedBlocks}: MultiSelectModeDependencies) =>
    selectedBlocks.length > 0,
  handler: async ({selectedBlocks}: MultiSelectModeDependencies) => {
    const choice = await openDialog(AddTagDialog)
    if (!choice) return
    try {
      const result = await appendTagToBlocks(selectedBlocks, choice.tagName)
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
  },
}

export const addTagGroupHeaderEntry: GroupedBacklinksGroupHeaderAction = {
  actionId: ADD_TAG_ACTION_ID,
}
