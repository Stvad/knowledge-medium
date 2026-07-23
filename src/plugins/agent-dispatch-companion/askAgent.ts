/**
 * Ask Agent — the explicit trigger. One gesture: make sure the block
 * carries the [[claude]] mention, clear any previous terminal
 * agent:* state (so a done/error block re-queues; the session id is
 * kept so the new run resumes the thread), mark the optimistic chip,
 * and fire the edit-settled signal so push detection skips the settle
 * window entirely — the daemon reacts in bridge-round-trip time.
 */
import type { Block } from '@/data/block'
import { ChangeScope, propertyValue } from '@/data/api'
import {
  ActionContextTypes,
  type ActionConfig,
} from '@/shortcuts/types.js'
import { notifyBlockEditSettled } from '@/editor/editSettleSignal.js'
import { AGENT_PROPS } from './chipState.ts'
import {
  agentActivityProp,
  agentAskedAtProp,
  agentAttemptsProp,
  agentCancelProp,
  agentErrorProp,
  agentStatusProp,
  agentUpdatedAtProp,
  agentWatcherProp,
} from './schema.ts'
import { markAskedAgent } from './askedStore.ts'

export const ASK_AGENT_ACTION_ID = 'agent-dispatch.ask'
export const EDIT_MODE_ASK_AGENT_ACTION_ID = 'edit.cm.agent-dispatch.ask'

/** The daemon's default backlink-watcher target. The mention is plain
 *  content — the reference projection turns it into the backlink the
 *  watcher sees. */
const DEFAULT_AGENT_MENTION = '[[claude]]'

/** Re-queueing clears the terminal lifecycle props but KEEPS
 *  agent:session — the retry resumes the thread — and agent:reply
 *  markers on children are untouched. Schema handles (not bare names) so the
 *  clear goes through the typed `unset` path and materializes correctly. */
const REQUEUE_CLEARED_PROPS = [
  agentStatusProp,
  agentUpdatedAtProp,
  agentAttemptsProp,
  agentErrorProp,
  agentActivityProp,
  // A retry starts clean: never inherit a stale Stop request (the daemon
  // clears agent:cancel on every terminal write, but drop it here too so
  // a re-queue can't hand a leftover flag to the fresh run).
  agentCancelProp,
  agentWatcherProp,
] as const

export const contentWithAgentMention = (content: string): string => {
  if (content.toLowerCase().includes(DEFAULT_AGENT_MENTION)) return content
  const trimmed = content.trimEnd()
  return trimmed ? `${trimmed} ${DEFAULT_AGENT_MENTION}` : DEFAULT_AGENT_MENTION
}

/** `liveContent`, when given, replaces the persisted content as the
 *  base for the mention write — the edit-mode action passes the editor
 *  doc, which leads the DB by up to the BlockEditor's commit debounce. */
export const askAgent = async (block: Block, liveContent?: string): Promise<void> => {
  if (block.repo.isReadOnly) return
  let wrote = false

  // ALWAYS make a real write — even when the mention and props already
  // look right (tx.update short-circuits a no-change patch WITHOUT
  // bumping the edit stamp). The agent:asked-at timestamp guarantees
  // the patch changes the block, and the resulting stamp bump is what
  // carries a PRE-BASELINE mention (typed before the watcher's baseline)
  // past the daemon's baseline gate; a "no-op" ask would otherwise be
  // silently unable to queue exactly those blocks.
  await block.repo.tx(async tx => {
    const fresh = await tx.get(block.id)
    if (!fresh) return
    // Content and props are now two writes in the one tx (setProperties can't
    // carry content). tx.update short-circuits an unchanged-content patch, and
    // the always-a-real-write guarantee rides the setProperties asked-at bump
    // below rather than the content patch. Tradeoff: when content DOES change
    // (first ask / re-ask that adds the mention) this emits two row_events /
    // two upload PATCHes instead of one — but both PATCHes share the tx's
    // tx_seq so they upload as a single CrudTransaction, and undo/MATERIALIZE
    // see the merged tx-net snapshot, so it's a minor cost, not a correctness
    // change. Combining them would require a whole-bag replace for the clear,
    // reintroducing the clobber setProperties exists to avoid.
    await tx.update(block.id, {content: contentWithAgentMention(liveContent ?? fresh.content ?? '')})
    // Clear lifecycle props only from TERMINAL states. An in-flight claim
    // (queued/running) is the daemon already doing what this gesture asks for
    // — clearing it would orphan the running task. setProperties applies a
    // DELTA (set asked-at, unset the terminal props), never a whole-bag
    // replace, so a claim the daemon synced in mid-gesture is preserved.
    const status = fresh.properties[AGENT_PROPS.status]
    const terminal = status !== 'queued' && status !== 'running'
    await tx.setProperties(block.id, {
      set: [propertyValue(agentAskedAtProp, Date.now())],
      unset: terminal ? REQUEUE_CLEARED_PROPS : [],
    })
    wrote = true
  }, {scope: ChangeScope.BlockDefault, description: 'ask agent'})
  if (!wrote) return

  markAskedAgent(block.id)
  // Explicit ask = the user is done by construction: skip the settle
  // window (the signal's delayed recheck catches this write's commit).
  notifyBlockEditSettled(block.id)
}

const normalModeAsk: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: ASK_AGENT_ACTION_ID,
  description: 'Ask Agent about this block',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}) => {
    await askAgent(block)
  },
}

const editModeAsk: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: EDIT_MODE_ASK_AGENT_ACTION_ID,
  description: 'Ask Agent about this block (Edit Mode)',
  context: ActionContextTypes.EDIT_MODE_CM,
  handler: async ({block, editorView}) => {
    // The editor doc, not the persisted block, is the source of truth
    // here — the DB trails it by the BlockEditor's commit debounce, so
    // basing the write on `fresh.content` could drop just-typed text.
    // The mention must ALSO go into the doc itself: the pending
    // debounced commit will push the doc text over whatever the tx
    // writes, and a doc without the mention would strip the backlink
    // right back out before the daemon ever saw it.
    const live = editorView.state.doc.toString()
    const next = contentWithAgentMention(live)
    if (next !== live) {
      const keptLength = live.trimEnd().length
      editorView.dispatch({
        changes: {from: keptLength, to: live.length, insert: next.slice(keptLength)},
      })
    }
    await askAgent(block, live)
  },
}

export const askAgentActions: readonly ActionConfig[] = [normalModeAsk, editModeAsk]
