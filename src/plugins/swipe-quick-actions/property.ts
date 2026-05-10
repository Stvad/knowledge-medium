import {
  ChangeScope,
  codecs,
  defineProperty,
} from '@/data/api'

/** Which block (by id) currently shows its swipe-action menu. Lives on
 *  the panel's UI-state block, so each panel has its own independent
 *  menu state — swiping in panel A doesn't disturb panel B's open menu,
 *  and the same block id rendered in two panels can't be confused for
 *  one another (the menu reads from its own panel's state and scopes
 *  its DOM lookup to its own panel root).
 *
 *  UiState scope: not undoable, never uploads. Right semantics for
 *  ephemeral chrome state. Same scope as `focusedBlockIdProp` /
 *  `isEditingProp` / `selectionStateProp`. */
export const swipeActiveBlockIdProp = defineProperty<string | undefined>('swipe-quick-actions:activeBlockId', {
  codec: codecs.optionalString,
  defaultValue: undefined,
  changeScope: ChangeScope.UiState,
})
