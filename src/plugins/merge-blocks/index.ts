/**
 * merge-blocks plugin — adds a "Merge into…" command-palette action on
 * any focused block. The action opens a picker that searches link
 * targets in the current workspace; on selection, `core.merge` folds
 * the source into the picked target. Content strategy (concat vs.
 * keepTarget) is decided at commit time by `pickMergeContentStrategy`
 * based on the two blocks' types.
 *
 * Composition mirrors the daily-notes reschedule trio:
 *   - `events.ts`            — cross-component open event
 *   - `MergePicker.tsx`      — modal mounted via appMountsFacet
 *   - `mergeAction.ts`       — block-context action that fires the event
 */
import { actionsFacet, appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { withSystemExtensionMetadata } from '@/extensions/togglable.ts'
import { MergePicker } from './MergePicker.tsx'
import { mergeIntoAction } from './mergeAction.ts'

export { MERGE_INTO_ACTION_ID, mergeIntoAction } from './mergeAction.ts'
export {
  openMergePicker,
  openMergePickerEvent,
  type OpenMergePickerEventDetail,
} from './events.ts'

const mergePickerMount: AppMountContribution = {
  id: 'merge-blocks.picker',
  component: MergePicker,
}

export const mergeBlocksPlugin: AppExtension = withSystemExtensionMetadata({
  name: 'Merge blocks',
  description: 'Block-merge actions (Backspace at start of a block merges into the previous one).',
}, [
  appMountsFacet.of(mergePickerMount, {source: 'merge-blocks'}),
  actionsFacet.of(mergeIntoAction, {source: 'merge-blocks'}),
])
