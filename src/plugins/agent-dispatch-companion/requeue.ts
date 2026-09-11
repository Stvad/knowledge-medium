/**
 * The one primitive for putting a finished agent task back in the queue.
 *
 * Shared by the explicit Ask Agent gesture (askAgent.ts) and the Retry
 * affordances (retryAgent.ts) so "what a re-queue clears" is stated once.
 * The daemon has no queue of its own — it re-derives pending work from
 * block properties every tick — so clearing the terminal `agent:*` props
 * IS the retry.
 */
import { propertyValue, type Tx } from '@/data/api'
import {
  agentActivityProp,
  agentAskedAtProp,
  agentAttemptsProp,
  agentCancelProp,
  agentErrorProp,
  agentRetryAfterProp,
  agentStatusProp,
  agentUpdatedAtProp,
  agentWatcherProp,
} from './schema.ts'

/** Re-queueing clears the terminal lifecycle props but KEEPS
 *  agent:session — the retry resumes the thread — and agent:reply
 *  markers on children are untouched. Schema handles (not bare names) so the
 *  clear goes through the typed `unset` path and materializes correctly. */
export const REQUEUE_CLEARED_PROPS = [
  agentStatusProp,
  agentUpdatedAtProp,
  agentAttemptsProp,
  agentErrorProp,
  agentActivityProp,
  // A deferred task carries a due time the daemon is waiting out. An
  // explicit retry means "now", so drop it — otherwise the gesture would
  // silently do nothing until the daemon's own clock came round.
  agentRetryAfterProp,
  // A retry starts clean: never inherit a stale Stop request (the daemon
  // clears agent:cancel on every terminal write, but drop it here too so
  // a re-queue can't hand a leftover flag to the fresh run).
  agentCancelProp,
  agentWatcherProp,
] as const

/** Re-queue one block inside a caller-owned transaction.
 *
 *  `agent:asked-at` is always written, even when the unset list is empty:
 *  `tx.update` short-circuits a no-change patch WITHOUT bumping the edit
 *  stamp, and that stamp bump is what carries a PRE-BASELINE mention past
 *  the daemon's baseline gate. A "no-op" re-queue would otherwise be
 *  silently unable to queue exactly those blocks.
 *
 *  Applies a DELTA (set asked-at, unset the terminal props), never a
 *  whole-bag replace, so a claim the daemon synced in mid-gesture is
 *  preserved. */
export const requeueAgentTask = async (
  tx: Tx,
  blockId: string,
  {clearTerminalState}: {clearTerminalState: boolean},
  nowMs = Date.now(),
): Promise<void> => {
  await tx.setProperties(blockId, {
    set: [propertyValue(agentAskedAtProp, nowMs)],
    unset: clearTerminalState ? REQUEUE_CLEARED_PROPS : [],
  })
}

/** A task the daemon is done with (or has deferred), i.e. one a retry may
 *  reset. Exactly `queued` (deferred), `done`, or `error` — an in-flight
 *  claim (`running`) is the daemon already doing what the gesture asks
 *  for (clearing it would orphan the running task), and an absent/unknown
 *  status means the block was never an agent task at all: Retry is a
 *  NORMAL_MODE action offered on every block, so this must not treat
 *  "no status" as retryable, or the gesture would write `agent:asked-at`
 *  and install a queued chip on an ordinary block that no watcher will
 *  ever claim.
 *
 *  `queued` IS resettable: the daemon only writes it for a task deferred
 *  behind an infrastructure outage, and resetting that just means "stop
 *  waiting, try now". */
export const isRequeueableStatus = (status: unknown): boolean =>
  status === 'queued' || status === 'done' || status === 'error'
