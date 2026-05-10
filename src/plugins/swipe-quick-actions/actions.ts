import { Block } from '@/data/block'
import { Repo } from '@/data/repo'

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
}

/** Primary toolbar — visible icons. Order: most-used to least-used,
 *  with destructive last so it's farthest from the swipe origin.
 *  `copy_block` here is the existing shared action that serializes the
 *  block + its subtree as indented markdown (the same handler the vim
 *  cmd+c binding uses) — not just the top-level content string. */
export const PRIMARY_ACTIONS: readonly QuickActionItem[] = [
  {actionId: 'copy_block', label: 'Copy'},
  {actionId: 'copy_block_ref', label: 'Copy Ref'},
  {actionId: 'open_focused_in_panel', label: 'Open'},
  {actionId: 'delete_block', label: 'Delete', destructive: true},
]

/** Secondary toolbar — hidden under the kebab/"More" button. Note:
 *  no separate "Copy ID" entry — Copy Ref produces `((id))` which is
 *  what users almost always want when they think "give me a reference
 *  to this block". The bare id is rarely useful on its own. */
export const OVERFLOW_ACTIONS: readonly QuickActionItem[] = [
  {actionId: 'zoom_in', label: 'Zoom In'},
  {actionId: 'toggle_collapse', label: 'Collapse'},
  {actionId: 'toggle_properties', label: 'Properties'},
  {actionId: 'copy_block_embed', label: 'Copy Embed'},
]
