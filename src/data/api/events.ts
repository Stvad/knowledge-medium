/** Engine-emitted events. Subscribed via `repo.events.<name>`.
 *  v1 only emits `cycleDetected` from the row_events tail when sync-
 *  applied parent_id mutations close a loop. See spec §4.7. */

import type { Unsubscribe } from './handle'

export interface CycleDetectedEvent {
  workspaceId: string
  /** Affected ids that participate in cycles (each row that closes back
   *  on itself; full cycle members enumerated via the runbook in §4.7). */
  startIds: string[]
  /** tx_ids of the row_events that triggered detection. Empty for the
   *  pure-sync case (the row_events trigger writes tx_id = NULL when
   *  source IS NULL, which is always true for PowerSync's CRUD-apply
   *  path); the field exists for completeness and future
   *  local-write-detected cycles. */
  txIdsInvolved: string[]
}

/** Tiny pub/sub primitive. Subscribers fire in registration order;
 *  exceptions are caught + logged so one bad listener doesn't poison
 *  the rest. Synchronous — emit returns once every listener has run. */
export interface EventChannel<T> {
  subscribe(listener: (event: T) => void): Unsubscribe
}

export interface RepoEvents {
  cycleDetected: EventChannel<CycleDetectedEvent>
}
