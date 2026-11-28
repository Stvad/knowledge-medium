import { ChangeScope, propertyValue, type BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import { AGENT_PROPS } from './chipState.ts'
import {
  agentActivityAtProp,
  agentActivityProp,
  agentCancelProp,
  agentErrorProp,
  agentStatusProp,
  agentUpdatedAtProp,
} from './schema.ts'

export const canRetryAgent = (row: BlockData | null | undefined): boolean => {
  if (!row || row.deleted || row.properties[AGENT_PROPS.status] !== 'error') return false
  return Boolean(row.properties[AGENT_PROPS.watcher])
}

export const retryAgent = async (block: Block): Promise<void> => {
  if (block.repo.isReadOnly) return

  await block.repo.tx(async tx => {
    if (!canRetryAgent(await tx.get(block.id))) return

    // Keep the watcher and session for routing, and the attempt count so the
    // next run gets a new reply key and preserves replies from earlier attempts.
    await tx.setProperties(block.id, {
      set: [propertyValue(agentStatusProp, 'queued'), propertyValue(agentUpdatedAtProp, Date.now())],
      unset: [agentErrorProp, agentActivityProp, agentActivityAtProp, agentCancelProp],
    })
  }, {scope: ChangeScope.BlockDefault, description: 'retry agent', skipUndo: true})
}
