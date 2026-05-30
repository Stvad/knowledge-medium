/** Engine-emitted event shapes. v1 only emits `cycleDetected` from the
 *  Layout B sync observer when sync-applied parent_id mutations close a
 *  loop; it surfaces as a `console.warn` (operators grep logs) plus an
 *  optional `onCycleDetected` callback on `SyncObserverOptions` for
 *  tests / future telemetry hooks. No pub/sub plumbing lives on `Repo`
 *  itself in v1 — there are no in-product subscribers and the alpha
 *  policy is "operator runs the §4.7 SQL runbook to fix manually". */

export interface CycleDetectedEvent {
  workspaceId: string
  /** Affected ids that participate in cycles (each row that closes back
   *  on itself; full cycle members enumerated via the runbook in §4.7). */
  startIds: string[]
  /** tx_ids involved in detection. Always empty for the sync-applied case
   *  (PowerSync's CRUD-apply / the observer's materialize write carry no
   *  tx_id); the field exists for completeness. */
  txIdsInvolved: string[]
}
