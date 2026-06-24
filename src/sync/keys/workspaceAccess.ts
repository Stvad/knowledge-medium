/**
 * §6 rule 3 — the UI access gate for the ACTIVE workspace.
 *
 * Complement to the resolver's `getMaterializability` (which collapses every
 * "can't render" case to `defer` for the observer). The UI needs one more
 * distinction the observer doesn't: WHY a workspace can't render, so it can show
 * the right prompt. Same authority — the local pin — read here against the
 * (untrusted, but safe-in-one-direction) server `encryption_mode` to split the
 * never-pinned case into its two branches:
 *
 *   pin 'plaintext'            → ready
 *   pin 'e2ee' + WK loaded      → ready
 *   pin 'e2ee' + WK absent       → locked: key-required (rule 3 "locked")
 *   unpinned + server 'e2ee'    → locked: key-required (branch a — trust e2ee,
 *                                  fail closed; prompt for the WK, no downgrade)
 *   unpinned + server 'none'    → locked: quarantine   (branch b — uncertain;
 *                                  offer paste-WK OR confirm-plaintext)
 *
 * Trusting server 'e2ee' can only make the client stricter (a key prompt);
 * distrusting server 'none' is what defeats a downgrade lie. With no
 * server-trusting rollout seed anymore, EVERY unpinned workspace takes this gate
 * on first encounter (quarantine for server 'none', key-required for server
 * 'e2ee'); confirming plaintext on the quarantine gate pins it, so the prompt is
 * one-time per (device, workspace).
 */

import type { ModePin } from './modePin.js'

export type WorkspaceAccess =
  | { readonly kind: 'ready' }
  | { readonly kind: 'locked'; readonly reason: 'key-required' | 'quarantine' }

export const resolveWorkspaceAccess = (
  pin: ModePin | null,
  serverEncryptionMode: string,
  hasKey: boolean,
): WorkspaceAccess => {
  if (pin === 'plaintext') return { kind: 'ready' }
  if (pin === 'e2ee') {
    return hasKey ? { kind: 'ready' } : { kind: 'locked', reason: 'key-required' }
  }
  // Unpinned — first encounter. Trust 'e2ee' (fail closed), quarantine 'none'.
  return serverEncryptionMode === 'e2ee'
    ? { kind: 'locked', reason: 'key-required' }
    : { kind: 'locked', reason: 'quarantine' }
}

/** Minimal shape of the local `workspaces` row the entry decision needs. */
export interface WorkspaceModeRow {
  readonly encryptionMode: string
}

export type WorkspaceEntry =
  | WorkspaceAccess
  /** The synced `workspaces` row isn't local yet and we can't decide safely
   *  without it — wait for it to replicate, then re-decide. */
  | { readonly kind: 'waiting' }

/**
 * Decide how to enter a workspace, accounting for whether its server row has
 * replicated locally yet. {@link resolveWorkspaceAccess} assumes the row's
 * `encryption_mode`/`wk_canary` are known; this wrapper guards the case where
 * they are NOT (a workspace opened by URL right after an RLS-allowed access
 * check, before sync delivered the row).
 *
 * We can decide WITHOUT the row only when the local pin settles it and no
 * server-supplied field is needed:
 *   - plaintext pin            → ready (bootstrap-writing plaintext is correct);
 *   - e2ee pin + WK loaded      → ready (materialization uses the pin/key, the
 *     row isn't needed; uploads seal via the pin).
 * Otherwise the row's `encryption_mode` (branch a/b) and `wk_canary` (to
 * validate a pasted key) are required, so a missing row means WAIT — never
 * proceed (which would bootstrap plaintext into a possibly-encrypted workspace)
 * and never gate with a null canary (which can't validate any key).
 */
export const decideWorkspaceEntry = (
  pin: ModePin | null,
  hasKey: boolean,
  row: WorkspaceModeRow | null,
): WorkspaceEntry => {
  const canDecideWithoutRow = pin === 'plaintext' || (pin === 'e2ee' && hasKey)
  if (!canDecideWithoutRow && row === null) return { kind: 'waiting' }
  return resolveWorkspaceAccess(pin, row?.encryptionMode ?? 'none', hasKey)
}
