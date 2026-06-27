import { dedupById, defineFacet } from '@/facets/facet.js'
import type { ActionContextType } from '@/shortcuts/types.js'

/** The action id of the toolbar's "Done" button — the one entry that genuinely
 *  wants edit mode to end, so the toolbar skips the edit-mode-keepalive hold for
 *  it (see MobileKeyboardToolbar). */
export const EXIT_EDIT_ACTION_ID = 'exit_edit_mode_cm'

/** One button on the mobile keyboard toolbar. Like the bottom nav
 *  (`MobileBottomNavItemContribution`), a button is just a reference to an
 *  action — its glyph and label are read from the action's `icon` /
 *  `description`, so presentation lives on the action (a button with no resolved
 *  icon is skipped). Add an icon to an action to give it a button. */
export interface MobileKeyboardToolbarItem {
  /** Stable identity — dedup key + React key. Distinct from `actionId`: the same
   *  action could appear under two items, and a duplicate `id` is a double-mount. */
  id: string
  /** Action dispatched (and read for icon/label) when the button is tapped. */
  actionId: string
  /** Disambiguates the action lookup when an id is registered under multiple
   *  contexts (e.g. `undo` is both GLOBAL and normal-mode). The toolbar only
   *  shows in edit mode, so this defaults to EDIT_MODE_CM. */
  context?: ActionContextType
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isMobileKeyboardToolbarItem = (
  value: unknown,
): value is MobileKeyboardToolbarItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.actionId === 'string' &&
  (value.context === undefined || typeof value.context === 'string')

// Rendered once per contribution keyed by `id` — dedup by `id` (last-wins),
// like mobile-bottom-nav. Ordering is by contribution `precedence` (ascending),
// applied by `runtime.read`.
export const mobileKeyboardToolbarItemsFacet = defineFacet<
  MobileKeyboardToolbarItem,
  readonly MobileKeyboardToolbarItem[]
>({
  id: 'mobile-keyboard-toolbar.items',
  combine: dedupById('mobile-keyboard-toolbar.items'),
  validate: isMobileKeyboardToolbarItem,
})
