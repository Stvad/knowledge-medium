import {useMemo} from 'react'
import {useEffectiveActions} from '@/shortcuts/useActionDiscovery'
import {ActionContextTypes} from '@/shortcuts/types'
import {createSequenceMatcher} from '@/shortcuts/sequenceMatcher'
import {JUMP_BLOCK_COUNT} from '@/plugins/vim-normal-mode/actions'

export const placeholderMoves: Readonly<Record<string, number>> = {
  move_down: 1, move_up: -1,
  jump_many_down: JUMP_BLOCK_COUNT, jump_many_up: -JUMP_BLOCK_COUNT,
  jump_to_first_visible_block: -Infinity, jump_to_last_visible_block: Infinity,
}
const editActions = new Set(['enter_edit_mode', 'enter_edit_mode_at_end', 'create_block_below_and_edit', 'create_block_above_and_edit'])

/** Reuse resolved bindings and the coordinator's matcher, including user remaps and sequences. */
export function usePlaceholderKeys() {
  const actions = useEffectiveActions()
  return useMemo(() => actions.flatMap(action => {
    if (action.context !== ActionContextTypes.NORMAL_MODE || !action.defaultBinding?.keys) return []
    if (!(action.id in placeholderMoves) && !editActions.has(action.id)) return []
    return [{move: placeholderMoves[action.id], matcher: createSequenceMatcher(action.defaultBinding.keys)}]
  }), [actions])
}
