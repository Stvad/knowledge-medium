/** Engine-emitted event shapes. v1 only emits `cycleDetected` from the
 *  row_events tail when sync-applied parent_id mutations close a loop;
 *  it surfaces as a `console.warn` (operators grep logs) plus an
 *  optional `onCycleDetected` callback on `RowEventsTailOptions` for
 *  tests / future telemetry hooks. No pub/sub plumbing lives on `Repo`
 *  itself in v1 — there are no in-product subscribers and the alpha
 *  policy is "operator runs the §4.7 SQL runbook to fix manually". */

export interface CycleDetectedEvent {
  workspaceId: string
  /** Affected ids that participate in cycles (each row that closes back
   *  on itself; full cycle members enumerated via the runbook in §4.7). */
  startIds: string[]
  /** tx_ids of the row_events that triggered detection. Empty for the
   *  pure-sync case (the row_events trigger writes tx_id = NULL when
   *  source IS NULL, which is always true for PowerSync's CRUD-apply
   *  path); the field exists for completeness. */
  txIdsInvolved: string[]
}
