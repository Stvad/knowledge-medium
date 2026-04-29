/** Engine-emitted events. Subscribed via `repo.events.<name>` in later
 *  stages. v1 only emits `cycleDetected` from the row_events tail when
 *  sync-applied cross-workspace moves close back on themselves. See §4.7. */

export interface CycleDetectedEvent {
  workspaceId: string
  /** Affected ids that participate in cycles (each row that closes back
   *  on itself; full cycle members enumerated via the runbook in §4.7). */
  startIds: string[]
  /** tx_ids of the row_events that triggered detection. */
  txIdsInvolved: string[]
}
