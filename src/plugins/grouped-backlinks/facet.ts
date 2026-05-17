import { defineFacet } from '@/extensions/facet.ts'
import type { ActionIcon } from '@/shortcuts/types.ts'

/** A group-header action entry. Each contribution renders one button
 *  in the grouped-backlinks group header that, when clicked, invokes
 *  the referenced `MULTI_SELECT_MODE` action with the group's source
 *  blocks as `selectedBlocks`.
 *
 *  Why an action-id reference instead of a free-form React component:
 *  the same operation (spread, tag, …) should be reachable through
 *  the command palette and the multi-select selection too. Pinning
 *  the surface to existing actions means we get those surfaces for
 *  free without re-implementing the dispatch path per plugin. */
export interface GroupedBacklinksGroupHeaderAction {
  /** ID of a `MULTI_SELECT_MODE` ActionConfig to invoke when this
   *  button is clicked. The action is resolved lazily at render time
   *  so contributions don't have to be registered in dependency
   *  order. */
  actionId: string
  /** Override the action's `icon`. Useful when one action surfaces
   *  through multiple entries (e.g. one tag-add action rendered as
   *  several differently-labelled chips). */
  icon?: ActionIcon
  /** Override the action's `description` for the button's tooltip and
   *  aria-label. */
  label?: string
  /** Extra data injected into the `CustomEvent.detail` passed to the
   *  action handler. Lets a single action serve multiple buttons
   *  (the chip carries which variant the user picked). */
  triggerDetail?: Record<string, unknown>
}

const isGroupedBacklinksGroupHeaderAction = (
  value: unknown,
): value is GroupedBacklinksGroupHeaderAction =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as GroupedBacklinksGroupHeaderAction).actionId === 'string'

export const groupedBacklinksGroupHeaderActionsFacet = defineFacet<
  GroupedBacklinksGroupHeaderAction,
  readonly GroupedBacklinksGroupHeaderAction[]
>({
  id: 'grouped-backlinks.group-header-actions',
  validate: isGroupedBacklinksGroupHeaderAction,
})
