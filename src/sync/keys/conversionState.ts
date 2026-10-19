/**
 * The server's record of an in-place plaintext → E2EE conversion, as a device
 * sees it (docs/workspace-e2ee-conversion.md §6.1). The read itself is the data
 * layer's (`fetchWorkspaceConversionState`); the decisions that consume it live
 * here with the pin and the key store.
 *
 * The phase only moves forward — `sealing` → `cleaning` → null — and the flip
 * sets the mode and `sealing` together, so a read that shows an e2ee workspace
 * past `sealing` stays true for good.
 */

export type ConversionPhase = 'sealing' | 'cleaning'

export interface WorkspaceConversionState {
  readonly encryptionMode: string
  /** null: no conversion is running (never converted, or finished). */
  readonly conversionPhase: ConversionPhase | null
  readonly wkCanary: string | null
  readonly ownerUserId: string
}

export type WorkspaceConversionRead =
  | {readonly kind: 'read'; readonly state: WorkspaceConversionState}
  /** Offline, a PostgREST error, a timeout, or no visible row: the phase is
   *  unknown, so nothing may be decided that `sealing` would forbid. */
  | {readonly kind: 'unavailable'; readonly error: unknown}
