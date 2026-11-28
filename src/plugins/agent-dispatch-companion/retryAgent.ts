import { ChangeScope, type BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import { AGENT_PROPS } from './chipState.ts'
import { agentRetryAtProp } from './schema.ts'

export const canRetryAgent = (row: BlockData | null | undefined): boolean => Boolean(row
  && !row.deleted
  && row.properties[AGENT_PROPS.status] === 'error'
  && row.properties[AGENT_PROPS.watcher])

export const retryAgent = async (block: Block): Promise<void> => {
  if (block.repo.isReadOnly) return

  await block.repo.tx(async tx => {
    if (!canRetryAgent(await tx.get(block.id))) return

    // The watcher acknowledges the retry only after rediscovering its input.
    await tx.setProperty(block.id, agentRetryAtProp, Date.now())
  }, {scope: ChangeScope.BlockDefault, description: 'retry agent', skipUndo: true})
}
