import { dedupById, defineFacet } from '@/facets/facet.js'
import {
  isActionRefContribution,
  type ActionRefContribution,
} from '@/shortcuts/actionRefItems.js'

/** The action id of the toolbar's "Done" button — the one entry that genuinely
 *  wants edit mode to end, so the toolbar skips the edit-mode-keepalive hold for
 *  it (see MobileKeyboardToolbar). */
export const EXIT_EDIT_ACTION_ID = 'exit_edit_mode_cm'

/** One button on the mobile keyboard toolbar — a reference to an action; its
 *  glyph and label are read from the action's `icon` / `description`, so
 *  presentation lives on the action (a button with no resolved icon is skipped).
 *  Add an icon to an action to give it a button. The shape is shared with the
 *  bottom nav ({@link ActionRefContribution}). */
export type MobileKeyboardToolbarItem = ActionRefContribution

// Rendered once per contribution keyed by `id` — dedup by `id` (last-wins),
// like mobile-bottom-nav. Ordering is by contribution `precedence` (ascending),
// applied by `runtime.read`.
export const mobileKeyboardToolbarItemsFacet = defineFacet<
  MobileKeyboardToolbarItem,
  readonly MobileKeyboardToolbarItem[]
>({
  id: 'mobile-keyboard-toolbar.items',
  combine: dedupById('mobile-keyboard-toolbar.items'),
  validate: isActionRefContribution,
})
