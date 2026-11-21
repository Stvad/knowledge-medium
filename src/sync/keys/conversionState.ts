/**
 * The server's record of an in-place plaintext → E2EE conversion, as a device
 * sees it (docs/workspace-e2ee-conversion.md §6.1). The read itself is the data
 * layer's (`fetchWorkspaceConversionState`); the decisions that consume it live
 * here with the pin and the key store.
 *
 * The phase only moves forward — `sealing` → `cleaning` → no
 * `workspace_conversions` row — and the flip sets the mode and inserts the
 * `sealing` row together, so a read that shows an e2ee workspace past `sealing`
 * stays true for good.
 */

// `unknown`: a phase this build doesn't know. It keeps every device closed, as
// `sealing` does, and the conversion flow does nothing under it.
export type ConversionPhase = 'sealing' | 'cleaning' | 'unknown'

/** Whether the phase forbids every unlock and pin upgrade: the server may
 *  still hold plaintext, and every write must wait for the purge. */
export const phaseKeepsWorkspaceClosed = (phase: ConversionPhase | null): boolean =>
  phase === 'sealing' || phase === 'unknown'

export interface WorkspaceConversionState {
  readonly encryptionMode: string
  /** null: no `workspace_conversions` row — none is running (never converted, or finished). */
  readonly conversionPhase: ConversionPhase | null
  readonly wkCanary: string | null
  readonly ownerUserId: string
}

export type WorkspaceConversionRead =
  | {readonly kind: 'read'; readonly state: WorkspaceConversionState}
  /** No row visible to this session: not a member (any more), or deleted. */
  | {readonly kind: 'not-visible'}
  /** Offline, a PostgREST error or a timeout: the phase is unknown, so nothing
   *  may be decided that `sealing` would forbid. */
  | {readonly kind: 'unavailable'; readonly error: unknown}
