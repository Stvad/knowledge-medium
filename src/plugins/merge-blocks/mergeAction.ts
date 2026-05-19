/**
 * "Merge into…" block action — opens the merge-target picker over the
 * focused block. Source = the focused block (the one that disappears);
 * target = whatever the user picks in the modal. Strategy (`'concat'`
 * vs `'keepTarget'`) is decided at commit time by `pickMergeContentStrategy`
 * looking at the two blocks' types, so the kernel mutator stays
 * policy-free (see `core.merge`).
 *
 * Visible for any block (no `canRun` gate) per the design discussion:
 * for outline blocks the user gets a concat-style merge they could've
 * gotten with Backspace; for pages they get the type-aware page merge.
 */
import { Combine } from 'lucide-react'
import {
  ActionConfig,
  ActionContextTypes,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.ts'
import { openMergePicker } from './events.ts'

export const MERGE_INTO_ACTION_ID = 'merge_blocks.merge_into'

export const mergeIntoAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: MERGE_INTO_ACTION_ID,
  description: 'Merge into…',
  context: ActionContextTypes.NORMAL_MODE,
  icon: Combine,
  handler: async ({block}: BlockShortcutDependencies) => {
    const data = block.peek() ?? await block.load()
    if (!data) return
    openMergePicker({
      sourceBlockId: block.id,
      workspaceId: data.workspaceId,
    })
  },
}
