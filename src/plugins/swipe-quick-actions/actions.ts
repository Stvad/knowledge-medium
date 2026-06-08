import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import { defineFacet } from '@/extensions/facet.js'

/** Semantic action invoked by a right-swipe on a block content surface.
 *  The gesture plugin owns the trigger; another plugin owns the baseline
 *  handler and other plugins can decorate it through `actionTransformsFacet`. */
export const SWIPE_RIGHT_BLOCK_ACTION_ID = 'block.swipe-right'

export interface QuickActionContext {
  block: Block
  repo: Repo
  uiStateBlock: Block
  workspaceId: string
}

/** A swipe-menu entry references a registered action by id and adds the
 *  bits of presentation that don't belong in the action itself: a short
 *  label that fits a 40px icon button, and whether to render with the
 *  destructive color. Everything else (handler, icon, description) is
 *  read from the action registry at click time, so adding a registered
 *  action's icon is enough to make it appear correctly here. */
export interface QuickActionItem {
  /** `Action.id` from `actionsFacet`. The swipe menu looks up the action
   *  at click time and invokes its handler with `{block, uiStateBlock}`
   *  directly — bypassing `useRunAction`'s context-active gate, since
   *  the swipe gesture is itself the activation. */
  actionId: string
  /** Short label for icon-button tooltip / overflow-menu text. Falls
   *  back to the action's `description` when omitted. */
  label?: string
  /** Renders the icon button with the destructive color. Default false. */
  destructive?: boolean
  /** True renders under the overflow menu; false/omitted renders in
   *  the primary one-row strip. */
  overflow?: boolean
  /** Optional toolbar row in the primary strip on mobile. Defaults to 1.
   *  Ignored for overflow items. Rows are grouped and rendered in
   *  ascending order, so plugins can add row 3+ without core changes. */
  row?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

export const isQuickActionItem = (value: unknown): value is QuickActionItem =>
  isRecord(value) &&
  typeof value.actionId === 'string' &&
  (value.label === undefined || typeof value.label === 'string') &&
  (value.destructive === undefined || typeof value.destructive === 'boolean') &&
  (value.overflow === undefined || typeof value.overflow === 'boolean') &&
  (value.row === undefined ||
    (typeof value.row === 'number' && Number.isInteger(value.row) && value.row >= 1))

export const quickActionItemsFacet = defineFacet<QuickActionItem, readonly QuickActionItem[]>({
  id: 'swipe-quick-actions.items',
  validate: isQuickActionItem,
})

/** Default visible items. Order: most-used to least-used, with
 *  destructive last so it's farthest from the swipe origin.
 *  `copy_block` here is the existing shared action that serializes the
 *  block + its subtree as indented markdown (the same handler the vim
 *  cmd+c binding uses) — not just the top-level content string. */
export const DEFAULT_QUICK_ACTION_ITEMS: readonly QuickActionItem[] = [
  {actionId: 'copy_block', label: 'Copy'},
  {actionId: 'copy_block_ref', label: 'Copy Ref'},
  {actionId: 'open_focused_in_panel', label: 'Open'},
  {actionId: 'toggle_properties', label: 'Properties'},
  {actionId: 'delete_block', label: 'Delete', destructive: true},
  // Overflow items. Note: no separate "Copy ID" entry — Copy Ref
  // produces `((id))`, which is what users almost always want when they
  // think "give me a reference to this block".
  {actionId: 'zoom_in', label: 'Zoom In', overflow: true},
  {actionId: 'toggle_collapse', label: 'Collapse', overflow: true},
  {actionId: 'copy_block_embed', label: 'Copy Embed', overflow: true},
]
