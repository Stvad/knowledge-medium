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
 * distrusting server 'none' is what defeats a downgrade lie. NOTE: this is safe
 * only once the rollout pin-seed has run (so pre-existing plaintext workspaces
 * are pinned, not treated as unpinned-server-none and quarantined).
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
