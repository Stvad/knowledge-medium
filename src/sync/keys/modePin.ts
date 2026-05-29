/**
 * Durable per-(user, workspace) E2EE mode pin (design doc §6).
 *
 * The pin — NOT the server's `encryption_mode` flag and NOT the
 * ephemeral workspace key — is the authority on whether a workspace is
 * E2EE *for this client*. It is:
 *
 *   - set once, the moment a WK first validates against the workspace's
 *     canary (→ `e2ee`) or a plaintext workspace is created/confirmed
 *     (→ `plaintext`), and locally immutable thereafter;
 *   - stored in localStorage so it SURVIVES a §6 Lock & wipe (which
 *     clears the SQLite DB and the IndexedDB workspace keys, but must
 *     leave each workspace's mode known so the wipe can't downgrade an
 *     e2ee workspace to plaintext).
 *
 * This module owns only the storage of pins and the one-time rollout
 * seed marker, plus its own localStorage key constants. Deciding *what*
 * to pin (canary validation, first-encounter quarantine) lives with the
 * flows that have that context (§8).
 */

// localStorage keys. Per repo convention each module owns its key
// constants (cf. localOnly.ts, lastWorkspace.ts) using the `kmp-` prefix.
// These deliberately live in localStorage so they SURVIVE a §6 Lock &
// wipe (which clears the SQLite DB and the IndexedDB workspace keys, but
// must leave each workspace's mode known so the wipe can't downgrade).
//
// localStorage is shared across all accounts in a browser profile (only
// the SQLite DB is per-user, via kmp-v6-<user_id>.db), so BOTH the pins
// and the rollout-seed marker are keyed by user id — otherwise a second
// account signing into the same profile would collide with the first.
const E2EE_MODE_PIN_PREFIX = 'kmp-e2ee-mode:'
const E2EE_PINS_SEEDED_PREFIX = 'kmp-e2ee-pins-seeded:'

export type ModePin = 'e2ee' | 'plaintext'

const isModePin = (value: string | null): value is ModePin =>
  value === 'e2ee' || value === 'plaintext'

const hasLocalStorage = (): boolean => {
  try {
    return typeof window !== 'undefined' && window.localStorage !== undefined
  } catch {
    return false
  }
}

// Ids are UUIDs today, but encode defensively so a delimiter inside an id
// can never make two distinct (user, workspace) pairs alias one key.
const pinStorageKey = (userId: string, workspaceId: string): string =>
  `${E2EE_MODE_PIN_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`

const seededMarkerKey = (userId: string): string =>
  `${E2EE_PINS_SEEDED_PREFIX}${encodeURIComponent(userId)}`

/** The pinned mode for this (user, workspace) on this device, or null if
 *  never pinned. */
export const getModePin = (userId: string, workspaceId: string): ModePin | null => {
  if (!hasLocalStorage()) return null
  try {
    const raw = localStorage.getItem(pinStorageKey(userId, workspaceId))
    return isModePin(raw) ? raw : null
  } catch {
    return null
  }
}

/**
 * Pin a workspace's mode. Set-once and locally immutable: re-pinning the
 * same value is a no-op; attempting to pin a *different* value throws,
 * because a mode flip is never legitimate (§6) and silently allowing it
 * would be exactly the downgrade the pin exists to prevent.
 */
export const setModePin = (
  userId: string,
  workspaceId: string,
  mode: ModePin,
): void => {
  const existing = getModePin(userId, workspaceId)
  if (existing === mode) return
  if (existing !== null) {
    throw new Error(
      `mode pin for (${userId}, ${workspaceId}) is immutable: ${existing} -> ${mode}`,
    )
  }
  if (!hasLocalStorage()) {
    throw new Error('cannot set E2EE mode pin: localStorage unavailable')
  }
  localStorage.setItem(pinStorageKey(userId, workspaceId), mode)
}

// The rollout seed (below) fires once per (user, device) at the pre-pin ->
// pin-aware transition. This marker value is a FIXED constant, deliberately NOT
// the running app version: a value that changed per release would re-arm the
// seed on every upgrade and re-open the server-trusting downgrade window for
// new unpinned memberships (§6). Bump it only for a deliberate, audited re-seed
// migration — never wire it to the app version.
const ROLLOUT_SEED_VERSION = '1'

/** True once the one-time rollout seed (below) has run for this user. Per-user
 *  so a second account in the same browser profile still seeds its own
 *  pre-existing memberships. */
export const arePinsSeeded = (userId: string): boolean => {
  if (!hasLocalStorage()) return false
  try {
    return localStorage.getItem(seededMarkerKey(userId)) === ROLLOUT_SEED_VERSION
  } catch {
    return false
  }
}

const markPinsSeeded = (userId: string): void => {
  if (!hasLocalStorage()) return
  localStorage.setItem(seededMarkerKey(userId), ROLLOUT_SEED_VERSION)
}

export interface SeedEntry {
  readonly workspaceId: string
  /** The server's `encryption_mode` for this membership at seed time. */
  readonly serverMode: ModePin
}

/**
 * One-time rollout seed (§6 "Pre-existing memberships on the rollout
 * release"), scoped to one user. On the first pin-aware release every
 * pre-existing workspace is unpinned; we initialize those pins directly
 * from the server's `encryption_mode` — the ONE place the design trusts
 * that field — because at that moment no E2EE workspace exists yet, so
 * there is nothing for the server to misrepresent.
 *
 * Safety properties this enforces:
 *   - keyed to the user + a FIXED `ROLLOUT_SEED_VERSION` constant (the pre-pin →
 *     pin-aware transition, NOT the per-release app version) and stored in
 *     wipe-surviving localStorage, so a §6 wipe that recreates an empty SQLite
 *     DB can NOT re-arm it; it fires at most once per (user, device);
 *   - per-user marker, so a different account signing into the same
 *     browser profile still seeds its own memberships;
 *   - never seeds over an existing pin, so a membership that was already
 *     pinned (and re-synced after a wipe) keeps its pin.
 *
 * `entries` are the signed-in user's memberships. Returns the number of
 * pins written. No-op (returns 0) if already seeded for this user.
 */
export const seedModePinsOnce = (
  userId: string,
  entries: readonly SeedEntry[],
): number => {
  if (arePinsSeeded(userId)) return 0
  let written = 0
  for (const entry of entries) {
    if (getModePin(userId, entry.workspaceId) === null) {
      setModePin(userId, entry.workspaceId, entry.serverMode)
      written++
    }
  }
  markPinsSeeded(userId)
  return written
}
