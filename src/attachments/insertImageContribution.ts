/**
 * The attachments plugin's image-insert surfaces: an EDIT_MODE_CM action and the
 * mobile keyboard toolbar button that dispatches it. Both live here (not in core)
 * so they only exist when capture does — disable the plugin and the "Insert
 * image" command + toolbar button vanish, rather than lingering as no-ops.
 *
 * The editor-side mechanics (file picker, edit-mode keepalive, caret insertion)
 * are the shared `pickAndInsertImages` helper; this module is just the wiring.
 */
import { ImagePlus } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.js'
import { INSERT_IMAGE_ACTION_ID, pickAndInsertImages } from '@/editor/insertImage.js'
import type { MobileKeyboardToolbarItem } from '@/plugins/mobile-keyboard-toolbar/facet.js'

/** Open the OS picker and drop the captured `((assetBlockId))` reference at the
 *  caret. No default chord (there's no idiom for "open a native picker"); reached
 *  via the toolbar button and the command palette. The handler clicks the picker
 *  synchronously so the dispatching gesture still counts as user activation. */
export const insertImageAction: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: INSERT_IMAGE_ACTION_ID,
  description: 'Insert image',
  context: ActionContextTypes.EDIT_MODE_CM,
  icon: ImagePlus,
  handler: async ({block, editorView}: CodeMirrorEditModeDependencies) => {
    if (!block || !editorView) return
    await pickAndInsertImages({editorView, block})
  },
}

/** The image button on the mobile keyboard toolbar. Registered with precedence
 *  50 (see attachmentsPlugin), placing it where it sat when hardcoded — between
 *  the reference triggers and the move buttons. */
export const insertImageToolbarItem: MobileKeyboardToolbarItem = {
  kind: 'icon',
  id: 'insert-image',
  actionId: INSERT_IMAGE_ACTION_ID,
  label: 'Insert image',
  icon: ImagePlus,
}
