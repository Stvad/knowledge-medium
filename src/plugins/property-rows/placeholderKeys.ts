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
const historyActions = new Set(['undo', 'redo'])
const editActions = new Set(['enter_edit_mode', 'enter_edit_mode_at_end', 'create_block_below_and_edit', 'create_block_above_and_edit'])

/** Reuse resolved bindings and the coordinator's matcher, including user remaps and sequences. */
export function usePlaceholderKeys() {
  const actions = useEffectiveActions()
  return useMemo(() => {
    const normalActions = actions.filter(action => action.context === ActionContextTypes.NORMAL_MODE)
    return {
      normalMode: normalActions.some(action => editActions.has(action.id)),
      keys: actions.flatMap(action => {
        if (!action.defaultBinding?.keys) return []
        const global = action.context === ActionContextTypes.GLOBAL
        if (!global && action.context !== ActionContextTypes.NORMAL_MODE && action.context !== ActionContextTypes.PROPERTY_EDITING) return []
        const kind = global || historyActions.has(action.id) ? 'global'
          : action.id in placeholderMoves ? 'move' : editActions.has(action.id) ? 'edit' : 'blocked'
        return [{id: action.id, kind, move: placeholderMoves[action.id], phase: action.defaultBinding.phase ?? 'keydown', matcher: createSequenceMatcher(action.defaultBinding.keys)}]
      }).sort((a, b) => Number(b.kind === 'global') - Number(a.kind === 'global')),
    }
  }, [actions])
}
