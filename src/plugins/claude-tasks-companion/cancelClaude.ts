/**
 * Cancel Claude — the explicit stop trigger. The daemon owns the
 * `claude:cancel` contract: it aborts a `running` task's child process,
 * parks the block `claude:status: error` + `claude:error: 'cancelled'`,
 * and clears `claude:cancel` itself. So the UI's only job is to write
 * `claude:cancel` on a block that's still `running` — the terminal
 * `error: cancelled` state is deliberately NOT re-runnable, so this
 * never touches other props or tries to reset the task.
 */
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import {
  ActionContextTypes,
  type ActionConfig,
} from '@/shortcuts/types.js'
import { CLAUDE_PROPS } from './chipState.ts'

export const CANCEL_CLAUDE_ACTION_ID = 'claude-tasks.cancel'

export const cancelClaude = async (block: Block): Promise<void> => {
  if (block.repo.isReadOnly) return

  await block.repo.tx(async tx => {
    const fresh = await tx.get(block.id)
    if (!fresh) return
    // Only a still-running task honors claude:cancel — writing it onto a
    // block that already finished (or was never claimed) would be a
    // no-op signal the daemon has no reason to see.
    if (fresh.properties[CLAUDE_PROPS.status] !== 'running') return
    await tx.update(block.id, {
      properties: {...fresh.properties, [CLAUDE_PROPS.cancel]: Date.now()},
    })
  }, {scope: ChangeScope.BlockDefault, description: 'cancel claude'})
}

const normalModeCancel: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: CANCEL_CLAUDE_ACTION_ID,
  description: 'Stop the running Claude task',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}) => {
    await cancelClaude(block)
  },
}

export const cancelClaudeActions: readonly ActionConfig[] = [normalModeCancel]
