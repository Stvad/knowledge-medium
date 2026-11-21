import { dedupById, defineFacet } from '@/facets/facet.js'
import {
  isActionRefContribution,
  type ActionRefContribution,
} from '@/shortcuts/actionRefItems.js'

/** One button on the selection toolbar: a reference to an action, whose icon
 *  and description draw it (an item that resolves to no icon is skipped).
 *  Unqualified items resolve in multi-select mode. Same shape as the bottom
 *  nav's and the keyboard toolbar's items. */
export type TouchSelectionToolbarItem = ActionRefContribution

// Rendered once per contribution keyed by `id`, ordered by precedence.
export const touchSelectionToolbarItemsFacet = defineFacet<
  TouchSelectionToolbarItem,
  readonly TouchSelectionToolbarItem[]
>({
  id: 'touch-selection.toolbar-items',
  combine: dedupById('touch-selection.toolbar-items'),
  validate: isActionRefContribution,
})
