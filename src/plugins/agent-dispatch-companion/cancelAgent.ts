/**
 * Stop Agent — the explicit stop trigger. The daemon owns the
 * `agent:cancel` contract: it aborts a `running` task's child process (or,
 * for a `queued` task it deferred behind an infrastructure outage, stops
 * waiting to retry it), parks the block `agent:status: error` +
 * `agent:error: 'cancelled'`, and clears `agent:cancel` itself. So the
 * UI's only job is to write `agent:cancel` on a block in one of those two
 * states — the terminal `error: cancelled` state is deliberately NOT
 * re-runnable, so this never touches other props or tries to reset the
 * task.
 */
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import {
  ActionContextTypes,
  type ActionConfig,
} from '@/shortcuts/types.js'
import { AGENT_PROPS } from './chipState.ts'
import { agentCancelProp } from './schema.ts'

export const CANCEL_AGENT_ACTION_ID = 'agent-dispatch.cancel'

export const cancelAgent = async (block: Block): Promise<void> => {
  if (block.repo.isReadOnly) return

  await block.repo.tx(async tx => {
    const fresh = await tx.get(block.id)
    if (!fresh) return
    // Only a live task honors agent:cancel — a still-`running` one, or a
    // `queued` one the daemon deferred and will otherwise keep retrying
    // by itself. Writing it onto a block that already finished (or was
    // never claimed) would be a no-op signal the daemon never looks at.
    const status = fresh.properties[AGENT_PROPS.status]
    if (status !== 'running' && status !== 'queued') return
    // A single typed set that merges the one key — never a whole-bag replace,
    // so a status/activity update the daemon syncs in mid-gesture is preserved.
    await tx.setProperty(block.id, agentCancelProp, Date.now())
  }, {scope: ChangeScope.BlockDefault, description: 'cancel agent'})
}

const normalModeCancel: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: CANCEL_AGENT_ACTION_ID,
  description: 'Stop the running Agent task',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}) => {
    await cancelAgent(block)
  },
}

export const cancelAgentActions: readonly ActionConfig[] = [normalModeCancel]
