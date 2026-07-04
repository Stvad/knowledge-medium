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
  CLAUDE_PROPS.activity,
  'claude:watcher',
] as const

export const contentWithClaudeMention = (content: string): string => {
  if (content.toLowerCase().includes(CLAUDE_MENTION)) return content
  const trimmed = content.trimEnd()
  return trimmed ? `${trimmed} ${CLAUDE_MENTION}` : CLAUDE_MENTION
}

/** `liveContent`, when given, replaces the persisted content as the
 *  base for the mention write — the edit-mode action passes the editor
 *  doc, which leads the DB by up to the BlockEditor's commit debounce. */
export const askClaude = async (block: Block, liveContent?: string): Promise<void> => {
  if (block.repo.isReadOnly) return
  const row = block.peek() ?? await block.load()
  if (!row) return

  // ALWAYS make a real write — even when the mention and props already
  // look right (tx.update short-circuits a no-change patch WITHOUT
  // bumping the edit stamp). The claude:asked-at timestamp guarantees
  // the patch changes the block, and the resulting stamp bump is what
  // carries a PRE-BASELINE mention (typed before the watcher's baseline)
  // past the daemon's baseline gate; a "no-op" ask would otherwise be
  // silently unable to queue exactly those blocks.
  await block.repo.tx(async tx => {
    const fresh = await tx.get(block.id)
    if (!fresh) return
    const properties: Record<string, unknown> = {...fresh.properties, [CLAUDE_PROPS.askedAt]: Date.now()}
    // Clear lifecycle props only from TERMINAL states. An in-flight
    // claim (queued/running) is the daemon already doing what this
    // gesture asks for — deleting it would orphan the running task
    // (tx.update replaces the whole properties map, so the claim that
    // synced in between would be gone).
    const status = fresh.properties[CLAUDE_PROPS.status]
    if (status !== 'queued' && status !== 'running') {
      for (const key of REQUEUE_CLEARED_PROPS) delete properties[key]
    }
    await tx.update(block.id, {
      content: contentWithClaudeMention(liveContent ?? fresh.content ?? ''),
      properties,
    })
  }, {scope: ChangeScope.BlockDefault, description: 'ask claude'})

  markAskedClaude(block.id)
  // Explicit ask = the user is done by construction: skip the settle
  // window (the signal's delayed recheck catches this write's commit).
  notifyBlockEditSettled(block.id)
}

const normalModeAsk: ActionConfig<typeof ActionContextTypes.NORMAL_MODE> = {
  id: ASK_CLAUDE_ACTION_ID,
  description: 'Ask Claude about this block',
  context: ActionContextTypes.NORMAL_MODE,
  handler: async ({block}) => {
    await askClaude(block)
  },
}

const editModeAsk: ActionConfig<typeof ActionContextTypes.EDIT_MODE_CM> = {
  id: EDIT_MODE_ASK_CLAUDE_ACTION_ID,
  description: 'Ask Claude about this block (Edit Mode)',
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
    const next = contentWithClaudeMention(live)
    if (next !== live) {
      const keptLength = live.trimEnd().length
      editorView.dispatch({
        changes: {from: keptLength, to: live.length, insert: next.slice(keptLength)},
      })
    }
    await askClaude(block, live)
  },
}

export const askClaudeActions: readonly ActionConfig[] = [normalModeAsk, editModeAsk]
