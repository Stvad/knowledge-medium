/**
 * The attachments plugin's image-insert surfaces: the EDIT_MODE_CM / NORMAL_MODE
 * actions and the mobile keyboard toolbar button. They live here (not in core)
 * so they only exist when capture does — disable the plugin and "Insert image"
 * (command + toolbar button) vanishes, rather than lingering as a no-op.
 *
 * The editor-side mechanics (file picker, edit-mode keepalive, caret insertion /
 * block append) are the shared helpers in `@/editor/insertImage`; this module is
 * just the wiring.
 */
import { ImagePlus } from 'lucide-react'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
  type CodeMirrorEditModeDependencies,
} from '@/shortcuts/types.js'
import {
  INSERT_IMAGE_ACTION_ID,
  INSERT_IMAGE_NORMAL_MODE_ACTION_ID,
  pickAndInsertImages,
  pickImagesIntoBlock,
} from '@/editor/insertImage.js'
import type { MobileKeyboardToolbarItem } from '@/plugins/mobile-keyboard-toolbar/facet.js'

/** Insert at the caret while editing. No default chord (no idiom for "open a
 *  native picker"); reached via the toolbar button and the command palette. The
 *  handler clicks the picker synchronously so the dispatching gesture still
 *  counts as user activation. */
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

/** Normal-mode variant — a focused-but-not-editing block has no caret, so this
 *  appends the image to the block's content. NORMAL_MODE is activated only by the
 *  vim plugin (off by default) and the palette lists only active-context actions,
 *  so this is reachable only for vim users (its normal-mode surfaces) — there's
 *  no default-config surface for it, by design: it's the "active in normal mode"
 *  counterpart to the EDIT_MODE_CM action above. */
export const insertImageNormalModeAction: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: INSERT_IMAGE_NORMAL_MODE_ACTION_ID,
  description: 'Insert image',
  context: ActionContextTypes.NORMAL_MODE,
  icon: ImagePlus,
  handler: async ({block}: BlockShortcutDependencies) => {
    if (!block) return
    await pickImagesIntoBlock(block)
  },
}

/** The image button on the mobile keyboard toolbar — a reference to the
 *  EDIT_MODE_CM action (its glyph/label come from the action). Its toolbar
 *  precedence is set where it's registered (see attachmentsPlugin). */
export const insertImageToolbarItem: MobileKeyboardToolbarItem = {
  id: 'insert-image',
  actionId: INSERT_IMAGE_ACTION_ID,
}
