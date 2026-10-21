/**
 * Durable per-(user, workspace) E2EE mode pin (design doc §6).
 *
 * The pin — NOT the server's `encryption_mode` flag and NOT the
 * ephemeral workspace key — is the authority on whether a workspace is
 * E2EE *for this client*. It is:
 *
 *   - set once, the moment a WK first validates against the workspace's
 *     canary (→ `e2ee`) or a plaintext workspace is created/confirmed
 *     (→ `plaintext`), and locally immutable thereafter — a server that
 *     flips its `encryption_mode` flag can't silently downgrade a pinned
 *     workspace. The single exception is {@link upgradeModePinToE2ee}, the
 *     one-way plaintext → e2ee move of an in-place conversion;
 *   - stored in localStorage, which (unlike the per-user SQLite DB,
 *     kmp-v6-<user_id>.db) is shared across all of a profile's accounts,
 *     so pins are keyed by user id. A full platform "clear site data"
 *     wipe clears these too; the workspace then re-resolves its mode on
 *     first encounter after re-login (the accepted post-wipe behavior).
 *
 * This module owns only the storage of pins, plus its own localStorage
 * key constant. Deciding *what* to pin (canary validation, first-encounter
 * quarantine) lives with the flows that have that context (§8).
 */

// localStorage key. Per repo convention each module owns its key
// constants (cf. localOnly.ts, lastWorkspace.ts) using the `kmp-` prefix.
// localStorage is shared across all accounts in a browser profile (only
// the SQLite DB is per-user, via kmp-v6-<user_id>.db), so pins are keyed
// by user id — otherwise a second account signing into the same profile
// would collide with the first.
const E2EE_MODE_PIN_PREFIX = 'kmp-e2ee-mode:'

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
 *  E2EE REQUIRES this — the pin is the durable per-(user, workspace) mode
 *  authority and the §6 gate keys off it — so the create flow preflights it
 *  rather than minting an encrypted workspace this device could never open.
 *  Plaintext doesn't need it (it has the session fallback). Probes with a temp
 *  key and cleans up. */
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

/**
 * The one transition a pin admits (docs/workspace-e2ee-conversion.md §5):
 * plaintext or unpinned → e2ee, for a workspace converted in place. A no-op on
 * an e2ee pin; nothing here can write plaintext, so a pin it touched stays e2ee
 * and {@link setModePin} refuses to take it back.
 *
 * Only the upgrade flow (`upgradeWorkspacePin` and its resume) calls it, after
 * a workspace key has opened the server's canary: a false e2ee claim can only stall this device, never make it
 * decrypt less, which is why the upgrade needs no more proof than that.
 */
export const upgradeModePinToE2ee = (userId: string, workspaceId: string): void => {
  if (getModePin(userId, workspaceId) === 'e2ee') return
  if (!hasLocalStorage()) {
    throw new Error('cannot upgrade E2EE mode pin: localStorage unavailable')
  }
  // A persisted pin outranks a session-only plaintext confirmation.
  localStorage.setItem(pinStorageKey(userId, workspaceId), 'e2ee')
}

// The pin-upgrade marker: written right before the pin moves to e2ee, cleared
// once the workspace's deferred rows have been drained under the new pin. It is
// the only local record of that window, because an upgraded pin reads exactly
// like any other e2ee pin while the rows deferred during the mismatch are still
// staged — and only a full workspace drain re-reads them.
const PIN_UPGRADE_MARKER_PREFIX = 'kmp-e2ee-pin-upgrade:'

const pinUpgradeMarkerKey = (userId: string, workspaceId: string): string =>
  `${PIN_UPGRADE_MARKER_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`

export const writePinUpgradeMarker = (userId: string, workspaceId: string): void => {
  if (!hasLocalStorage()) {
    throw new Error('cannot write pin-upgrade marker: localStorage unavailable')
  }
  localStorage.setItem(pinUpgradeMarkerKey(userId, workspaceId), '1')
}

export const hasPinUpgradeMarker = (userId: string, workspaceId: string): boolean => {
  if (!hasLocalStorage()) return false
  try {
    return localStorage.getItem(pinUpgradeMarkerKey(userId, workspaceId)) !== null
  } catch {
    return false
  }
}

export const clearPinUpgradeMarker = (userId: string, workspaceId: string): void => {
  if (!hasLocalStorage()) return
  localStorage.removeItem(pinUpgradeMarkerKey(userId, workspaceId))
}
