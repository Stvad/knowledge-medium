/** extract-type plugin — UI surface for user-defined-types extraction.
 *
 *  Contributes:
 *   - `extractTypeAction` (NORMAL_MODE) — "Extract type from this
 *     block" via the command palette / shortcut binding. Dispatches
 *     a window event the dialog listens for. On submit, creates the
 *     type and delegates to find-type-instances.
 *   - `findTypeInstancesAction` (NORMAL_MODE) — "Find instances of
 *     this type." Only surfaces on block-type blocks. Picker for the
 *     type's properties with optional value filters → retag candidate
 *     confirmation.
 *   - `ExtractTypeDialog` + `FindTypeInstancesDialog` (global app
 *     mounts) — the two dialogs that listen for their respective
 *     events. */

import { actionsFacet, appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ExtractTypeDialog } from './ExtractTypeDialog.tsx'
import { FindTypeInstancesDialog } from './FindTypeInstancesDialog.tsx'
import {
  extractTypeAction,
  findTypeInstancesAction,
} from './action.ts'

export {
  extractTypeAction,
  findTypeInstancesAction,
  EXTRACT_TYPE_ACTION_ID,
  FIND_TYPE_INSTANCES_ACTION_ID,
} from './action.ts'
export {
  openExtractTypeDialog,
  openExtractTypeDialogEvent,
  openFindTypeInstancesDialog,
  openFindTypeInstancesDialogEvent,
} from './events.ts'
export type {
  OpenExtractTypeDialogEventDetail,
  OpenFindTypeInstancesDialogEventDetail,
} from './events.ts'
export { ExtractTypeDialog } from './ExtractTypeDialog.tsx'
export { FindTypeInstancesDialog } from './FindTypeInstancesDialog.tsx'

const extractTypeDialogMount: AppMountContribution = {
  id: 'extract-type.dialog',
  component: ExtractTypeDialog,
}

const findTypeInstancesDialogMount: AppMountContribution = {
  id: 'extract-type.find-type-instances-dialog',
  component: FindTypeInstancesDialog,
}

export const extractTypePlugin: AppExtension = [
  actionsFacet.of(extractTypeAction, {source: 'extract-type'}),
  actionsFacet.of(findTypeInstancesAction, {source: 'extract-type'}),
  appMountsFacet.of(extractTypeDialogMount, {source: 'extract-type'}),
  appMountsFacet.of(findTypeInstancesDialogMount, {source: 'extract-type'}),
]
