/** extract-type plugin — UI surface for the user-defined-types Phase
 *  3 extract-type-from-prototype flow.
 *
 *  Contributes:
 *   - `extractTypeAction` (NORMAL_MODE) — "Extract type from this
 *     block" via the command palette / shortcut binding. Dispatches
 *     a window event the dialog listens for.
 *   - `ExtractTypeDialog` (global app mount) — the two-step dialog
 *     that names the type, picks the property subset, surfaces
 *     candidates, and calls the typeExtraction primitives. */

import { actionsFacet, appMountsFacet, type AppMountContribution } from '@/extensions/core.ts'
import type { AppExtension } from '@/extensions/facet.ts'
import { ExtractTypeDialog } from './ExtractTypeDialog.tsx'
import { extractTypeAction } from './action.ts'

export { extractTypeAction, EXTRACT_TYPE_ACTION_ID } from './action.ts'
export { openExtractTypeDialog, openExtractTypeDialogEvent } from './events.ts'
export type { OpenExtractTypeDialogEventDetail } from './events.ts'
export { ExtractTypeDialog } from './ExtractTypeDialog.tsx'

const extractTypeDialogMount: AppMountContribution = {
  id: 'extract-type.dialog',
  component: ExtractTypeDialog,
}

export const extractTypePlugin: AppExtension = [
  actionsFacet.of(extractTypeAction, {source: 'extract-type'}),
  appMountsFacet.of(extractTypeDialogMount, {source: 'extract-type'}),
]
