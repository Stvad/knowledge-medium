/**
 * Ask Claude — the explicit trigger. One gesture: make sure the block
 * carries the [[claude]] mention, clear any previous terminal
 * claude:* state (so a done/error block re-queues; the session id is
 * kept so the new run resumes the thread), mark the optimistic chip,
 * and fire the edit-settled signal so push detection skips the settle
 * window entirely — the daemon reacts in bridge-round-trip time.
 */
import type { Block } from '@/data/block'
import { ChangeScope } from '@/data/api'
import {
  ActionContextTypes,
  type ActionConfig,
  type BlockShortcutDependencies,
} from '@/shortcuts/types.js'
import { notifyBlockEditSettled } from '@/editor/editSettleSignal.js'
import { CLAUDE_PROPS } from './chipState.ts'
import { markAskedClaude } from './askedStore.ts'

export const ASK_CLAUDE_ACTION_ID = 'claude-tasks.ask'
export const EDIT_MODE_ASK_CLAUDE_ACTION_ID = 'edit.cm.claude-tasks.ask'

/** The daemon's default backlink-watcher target. The mention is plain
 *  content — the reference projection turns it into the backlink the
 *  watcher sees. */
const CLAUDE_MENTION = '[[claude]]'

/** Re-queueing clears the terminal lifecycle props but KEEPS
 *  claude:session — the retry resumes the thread — and claude:reply
 *  markers on children are untouched. */
const REQUEUE_CLEARED_PROPS = [
  CLAUDE_PROPS.status,
  CLAUDE_PROPS.updatedAt,
  CLAUDE_PROPS.attempts,
  CLAUDE_PROPS.error,
  'claude:watcher',
] as const

export const contentWithClaudeMention = (content: string): string => {
  if (content.toLowerCase().includes(CLAUDE_MENTION)) return content
  const trimmed = content.trimEnd()
  return trimmed ? `${trimmed} ${CLAUDE_MENTION}` : CLAUDE_MENTION
}

export const askClaude = async (block: Block): Promise<void> => {
  if (block.repo.isReadOnly) return
  const row = block.peek() ?? await block.load()
  if (!row) return

  const nextContent = contentWithClaudeMention(row.content ?? '')
  const hasLifecycleState = REQUEUE_CLEARED_PROPS.some(key => row.properties[key] !== undefined)

  if (nextContent !== row.content || hasLifecycleState) {
    await block.repo.tx(async tx => {
      const fresh = await tx.get(block.id)
      if (!fresh) return
      const properties = {...fresh.properties}
      for (const key of REQUEUE_CLEARED_PROPS) delete properties[key]
      await tx.update(block.id, {
        content: contentWithClaudeMention(fresh.content ?? ''),
        properties,
      })
    }, {scope: ChangeScope.BlockDefault, description: 'ask claude'})
  }

  markAskedClaude(block.id)
  // Explicit ask = the user is done by construction: skip the settle
  // window (the signal's delayed recheck catches this write's commit).
  notifyBlockEditSettled(block.id)
}

const createAskClaudeAction = <T extends typeof ActionContextTypes.NORMAL_MODE | typeof ActionContextTypes.EDIT_MODE_CM>(
  context: T,
  id: string,
  description: string,
): ActionConfig<T> => ({
  id,
  description,
  context,
  handler: (async ({block}: BlockShortcutDependencies) => {
    await askClaude(block)
  }) as ActionConfig<T>['handler'],
})

export const askClaudeActions: readonly ActionConfig[] = [
  createAskClaudeAction(ActionContextTypes.NORMAL_MODE, ASK_CLAUDE_ACTION_ID, 'Ask Claude about this block'),
  createAskClaudeAction(ActionContextTypes.EDIT_MODE_CM, EDIT_MODE_ASK_CLAUDE_ACTION_ID, 'Ask Claude about this block (Edit Mode)'),
]
