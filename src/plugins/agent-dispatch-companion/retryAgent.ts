import { ChangeScope, type BlockData } from '@/data/api'
import type { Block } from '@/data/block'
import { agentSubtreeKeyProp } from '@/plugins/agent-runtime/schema.ts'
import { AGENT_PROPS } from './chipState.ts'
import { agentRetryAtProp } from './schema.ts'

export type RetrySource = {kind: 'mention'} | {kind: 'legacy', replyKey: string}

export const retrySourceFor = (row: BlockData | null | undefined): RetrySource | null => {
  if (!row || row.deleted || row.properties[AGENT_PROPS.status] !== 'error' || !row.properties[AGENT_PROPS.watcher]) return null
  const kind = row.properties[AGENT_PROPS.watcherKind]
  if (kind === 'backlinks') return {kind: 'mention'}
  if (kind !== undefined) return null

  // Older dispatch versions recorded the watcher kind in the reply key only.
  const attempt = row.properties[AGENT_PROPS.attempts]
  if (typeof attempt !== 'number' || !Number.isSafeInteger(attempt) || attempt <= 0) return null
  return {kind: 'legacy', replyKey: `reply:${row.id}:${attempt}`}
}

export const hasLegacyMentionReply = (children: readonly BlockData[] | undefined, replyKey: string): boolean =>
  children?.some(child => child.properties[AGENT_PROPS.reply] === true
    && child.properties[agentSubtreeKeyProp.name] === replyKey) ?? false

export const retryAgent = async (block: Block): Promise<void> => {
  if (block.repo.isReadOnly) return

  await block.repo.tx(async tx => {
    const source = retrySourceFor(await tx.get(block.id))
    if (!source) return
    if (source.kind === 'legacy'
      && !hasLegacyMentionReply(await tx.childrenOf(block.id, undefined, {propertyChildren: 'none'}), source.replyKey)) return

    // The watcher acknowledges the retry only after rediscovering its input.
    await tx.setProperty(block.id, agentRetryAtProp, Date.now())
  }, {scope: ChangeScope.BlockDefault, description: 'retry agent', skipUndo: true})
}
