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
    if (fresh.properties[AGENT_PROPS.status] !== 'running') return
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
