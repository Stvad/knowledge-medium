/** extract-type plugin — UI surface for the user-defined-types Phase
 *  3 extract-type-from-prototype flow plus a sibling find-similar
 *  command that surfaces the same candidate discovery without
 *  creating a type.
 *
 *  Contributes:
 *   - `extractTypeAction` (NORMAL_MODE) — "Extract type from this
 *     block" via the command palette / shortcut binding. Dispatches
 *     a window event the dialog listens for.
 *   - `findSimilarAction` (NORMAL_MODE) — "Find blocks with similar
 *     properties." Same property-picker UI as extract-type step 1
 *     but the result is just a navigable list — useful when you
 *     want to discover matching blocks without committing to a type.
 *   - `ExtractTypeDialog` + `FindSimilarDialog` (global app mounts) —
 *     the two dialogs that listen for their respective events. */

import { actionsFacet, appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ExtractTypeDialog } from './ExtractTypeDialog.tsx'
import { FindSimilarDialog } from './FindSimilarDialog.tsx'
import { FindTypeInstancesDialog } from './FindTypeInstancesDialog.tsx'
import {
  extractTypeAction,
  findSimilarAction,
  findTypeInstancesAction,
} from './action.ts'

export {
  extractTypeAction,
  findSimilarAction,
  findTypeInstancesAction,
  EXTRACT_TYPE_ACTION_ID,
  FIND_SIMILAR_ACTION_ID,
  FIND_TYPE_INSTANCES_ACTION_ID,
} from './action.ts'
export {
  openExtractTypeDialog,
  openExtractTypeDialogEvent,
  openFindSimilarDialog,
  openFindSimilarDialogEvent,
  openFindTypeInstancesDialog,
  openFindTypeInstancesDialogEvent,
} from './events.ts'
export type {
  OpenExtractTypeDialogEventDetail,
  OpenFindSimilarDialogEventDetail,
  OpenFindTypeInstancesDialogEventDetail,
} from './events.ts'
export { ExtractTypeDialog } from './ExtractTypeDialog.tsx'
export { FindSimilarDialog } from './FindSimilarDialog.tsx'
export { FindTypeInstancesDialog } from './FindTypeInstancesDialog.tsx'

const extractTypeDialogMount: AppMountContribution = {
  id: 'extract-type.dialog',
  component: ExtractTypeDialog,
}

const findSimilarDialogMount: AppMountContribution = {
  id: 'extract-type.find-similar-dialog',
  component: FindSimilarDialog,
}

const findTypeInstancesDialogMount: AppMountContribution = {
  id: 'extract-type.find-type-instances-dialog',
  component: FindTypeInstancesDialog,
}

export const extractTypePlugin: AppExtension = [
  actionsFacet.of(extractTypeAction, {source: 'extract-type'}),
  actionsFacet.of(findSimilarAction, {source: 'extract-type'}),
  actionsFacet.of(findTypeInstancesAction, {source: 'extract-type'}),
  appMountsFacet.of(extractTypeDialogMount, {source: 'extract-type'}),
  appMountsFacet.of(findSimilarDialogMount, {source: 'extract-type'}),
  appMountsFacet.of(findTypeInstancesDialogMount, {source: 'extract-type'}),
]
