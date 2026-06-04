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

// Session-only plaintext confirmations: workspaces the user explicitly
// confirmed plaintext in the §6 gate when localStorage couldn't persist the pin
// (writes blocked / quota) while the rest of the app still works. This keeps a
// plaintext user from being trapped on the quarantine gate in a degraded
// storage environment. It is in-memory (lost on reload → re-quarantine, where
// storage may have recovered), and ONLY ever holds user-confirmed plaintext —
// never anything derived from the server — so it carries no downgrade risk. A
// real persisted pin always takes precedence.
const sessionPlaintext = new Set<string>()

const readPersistedPin = (key: string): ModePin | null => {
  if (!hasLocalStorage()) return null
  try {
    const raw = localStorage.getItem(key)
    return isModePin(raw) ? raw : null
  } catch {
    return null
  }
}

/** The pinned mode for this (user, workspace) on this device, or null if
 *  never pinned. A persisted pin wins; otherwise a session-only plaintext
 *  confirmation (see {@link confirmPlaintextForSession}) counts as plaintext. */
export const getModePin = (userId: string, workspaceId: string): ModePin | null => {
  const key = pinStorageKey(userId, workspaceId)
  return readPersistedPin(key) ?? (sessionPlaintext.has(key) ? 'plaintext' : null)
}

/** Record a plaintext confirmation that couldn't be persisted (localStorage
 *  unavailable), so {@link getModePin} reports plaintext for this session and
 *  the user can load the workspace. Re-quarantines on next load. */
export const confirmPlaintextForSession = (userId: string, workspaceId: string): void => {
  sessionPlaintext.add(pinStorageKey(userId, workspaceId))
}

/** True if this device can durably persist mode pins (localStorage is writable).
 *  E2EE REQUIRES this — the pin is the wipe-surviving authority and the §6 gate
 *  keys off it — so the create flow preflights it rather than minting an
 *  encrypted workspace this device could never open. Plaintext doesn't need it
 *  (it has the session fallback). Probes with a temp key and cleans up. */
export const canPersistPins = (): boolean => {
  if (!hasLocalStorage()) return false
  try {
    const probe = `${E2EE_MODE_PIN_PREFIX}__probe__`
    localStorage.setItem(probe, '1')
    localStorage.removeItem(probe)
    return true
  } catch {
    return false
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
  // Throw (rather than silently no-op) when the seal can't be persisted, so
  // seal-first seeding can abort BEFORE writing any pin — see seedModePinsOnce.
  if (!hasLocalStorage()) {
    throw new Error('cannot seal E2EE pin seed: localStorage unavailable')
  }
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
 *
 * SEAL FIRST: the "ran once" marker is written BEFORE any pin. If the seal
 * can't be persisted (localStorage blocked) this throws before trusting a
 * single server flag — so we never leave the dangerous "some pins written but
 * not sealed" state, which a later boot would re-seed (re-trusting the server
 * `encryption_mode` for any membership that synced in the meantime — a
 * downgrade vector if a hostile/stale server flagged an e2ee workspace `none`).
 * If sealing succeeds but a later pin write fails, the workspace is already
 * sealed, so the unpinned remainder takes the first-encounter gate on next
 * load — never a re-seed. (The caller wraps this best-effort so a seal failure
 * doesn't crash startup.)
 */
export const seedModePinsOnce = (
  userId: string,
  entries: readonly SeedEntry[],
): number => {
  if (arePinsSeeded(userId)) return 0
  markPinsSeeded(userId)
  let written = 0
  for (const entry of entries) {
    if (getModePin(userId, entry.workspaceId) === null) {
      setModePin(userId, entry.workspaceId, entry.serverMode)
      written++
    }
  }
  return written
}
