/**
 * Retry — put a finished agent task back in the queue, one block or the
 * whole failed batch.
 *
 * Why a bulk form exists: the daemon's failures arrive in batches. A
 * credit outage, an expired login, or a dead bridge hits every task the
 * daemon touches while it lasts, so "fix the cause, then re-run the ones
 * that died" is the normal recovery, and doing it block-by-block is the
 * part that makes an outage feel unrecoverable. (The daemon now *defers*
 * the failures it can recognise — see packages/agent-dispatch/src/
 * runFailure.ts — so this is the escape hatch for the ones it can't.)
 *
 * Unlike Ask Agent this never touches block CONTENT: the mention that
 * triggered the task is already there, and it need not be `[[claude]]` —
 * a watcher can target any page, so rewriting content here would bolt a
 * `[[claude]]` onto tasks belonging to some other watcher.
 */
import { ChangeScope } from '@/data/api'
import type { Block } from '@/data/block'
import type { Repo } from '@/data/repo'
import {
  ActionContextTypes,
  type ActionConfig,
} from '@/shortcuts/types.js'
import { notifyBlockEditSettled } from '@/editor/editSettleSignal.js'
import { RotateCcw } from 'lucide-react'
import { showError, showInfo, showSuccess } from '@/utils/toast.js'
import { AGENT_PROPS } from './chipState.ts'
import { isRequeueableStatus, requeueAgentTask } from './requeue.ts'
import { markAskedAgent } from './askedStore.ts'

export const RETRY_AGENT_ACTION_ID = 'agent-dispatch.retry'
export const RETRY_FAILED_AGENT_TASKS_ACTION_ID = 'agent-dispatch.retry-failed'

/** Post-write UI: optimistic chip + the settle signal, so push detection
 *  skips the quiet window and the daemon reacts in bridge-round-trip time
 *  instead of after `quietMs`. */
const announceRequeued = (blockId: string): void => {
  markAskedAgent(blockId)
  notifyBlockEditSettled(blockId)
}

/** Re-queue ONE task. Returns false when there was nothing to re-queue
 *  (block gone, or the daemon is already running it). */
export const retryAgentTask = async (block: Block): Promise<boolean> => {
  if (block.repo.isReadOnly) return false
  let requeued = false

  await block.repo.tx(async tx => {
    const fresh = await tx.get(block.id)
    if (!fresh) return
    // Re-read inside the tx: the pre-filter that offered this action ran
    // against a possibly-stale snapshot, and the daemon may have claimed
    // the block since. Resetting a live claim would orphan its run.
    if (!isRequeueableStatus(fresh.properties[AGENT_PROPS.status])) return
    await requeueAgentTask(tx, block.id, {clearTerminalState: true})
    requeued = true
  }, {scope: ChangeScope.BlockDefault, description: 'retry agent task'})

  if (requeued) announceRequeued(block.id)
  return requeued
}

/** Re-queue every failed task in the ACTIVE workspace, in one
 *  transaction — so an outage's worth of dead tasks is one gesture and
 *  one undo entry.
 *
 *  Scoped to the active workspace on purpose: the local `blocks` table
 *  holds every synced workspace, and a global sweep would re-run (and
 *  bill) tasks in workspaces the user isn't even looking at. */
export const retryFailedAgentTasks = async (repo: Repo): Promise<number> => {
  if (repo.isReadOnly) return 0
  const failed = await repo.queryActiveWorkspace({where: {[AGENT_PROPS.status]: 'error'}})
  if (failed.length === 0) return 0

  const requeued: string[] = []
  await repo.tx(async tx => {
    for (const row of failed) {
      const fresh = await tx.get(row.id)
      if (!fresh) continue
      // Still failed? The query snapshot predates the tx, and a daemon
      // that picked the task up in between owns it now.
      if (fresh.properties[AGENT_PROPS.status] !== 'error') continue
      await requeueAgentTask(tx, row.id, {clearTerminalState: true})
      requeued.push(row.id)
    }
  }, {scope: ChangeScope.BlockDefault, description: 'retry failed agent tasks'})

  for (const id of requeued) announceRequeued(id)
  return requeued.length
}

const retryOne: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: RETRY_AGENT_ACTION_ID,
  description: 'Retry this Agent task',
  context: ActionContextTypes.NORMAL_MODE,
  icon: RotateCcw,
  handler: async ({block}) => {
    await retryAgentTask(block)
  },
}

export const retryFailedAgentTasksAction = ({repo}: {repo: Repo}): ActionConfig<typeof ActionContextTypes.GLOBAL> => ({
  id: RETRY_FAILED_AGENT_TASKS_ACTION_ID,
  description: 'Retry all failed Agent tasks',
  context: ActionContextTypes.GLOBAL,
  icon: RotateCcw,
  handler: async () => {
    try {
      const count = await retryFailedAgentTasks(repo)
      if (count === 0) showInfo('No failed Agent tasks to retry.')
      else showSuccess(`Re-queued ${count} failed Agent task${count === 1 ? '' : 's'}.`)
    } catch (error) {
      console.error('[agent-dispatch-companion] retry-all failed:', error)
      showError(`Could not retry: ${error instanceof Error ? error.message : String(error)}`)
    }
  },
})

export const retryAgentActions = ({repo}: {repo: Repo}): readonly ActionConfig[] =>
  [retryOne, retryFailedAgentTasksAction({repo})]
