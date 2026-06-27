import { dedupById, defineFacet } from '@/facets/facet.js'
import type { ActionIcon } from '@/shortcuts/types.js'

/** The action id of the toolbar's "Done" button — the one entry that genuinely
 *  wants edit mode to end, so the toolbar skips the edit-mode-keepalive hold for
 *  it (see MobileKeyboardToolbar). Shared so the contribution and the component
 *  agree on the id. */
export const EXIT_EDIT_ACTION_ID = 'exit_edit_mode_cm'

interface MobileKeyboardToolbarItemBase {
  /** Stable identity — dedup key + React key. Distinct from `actionId`: the same
   *  action could appear under two items, and a duplicate `id` is a double-mount. */
  id: string
  /** Action dispatched (via `runAction`) when the button is tapped. Its context
   *  must be active while editing (EDIT_MODE_CM, or an always-on GLOBAL action
   *  like undo/redo) since the toolbar only shows in edit mode. */
  actionId: string
  /** aria-label / tooltip. */
  label: string
}

/** One button on the mobile keyboard toolbar. Unlike the bottom nav (which
 *  derives its glyph from the action's `icon`), toolbar items carry their own
 *  presentation: several toolbar actions have no `icon`, and the reference
 *  triggers render a text glyph (`[[`, `((`) rather than an icon. */
export type MobileKeyboardToolbarItem =
  | (MobileKeyboardToolbarItemBase & { kind: 'icon'; icon: ActionIcon })
  | (MobileKeyboardToolbarItemBase & { kind: 'text'; text: string })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isMobileKeyboardToolbarItem = (
  value: unknown,
): value is MobileKeyboardToolbarItem =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  typeof value.actionId === 'string' &&
  typeof value.label === 'string' &&
  ((value.kind === 'icon' && value.icon != null) ||
    (value.kind === 'text' && typeof value.text === 'string'))

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
