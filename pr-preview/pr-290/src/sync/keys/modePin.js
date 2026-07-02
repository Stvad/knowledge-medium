//#region src/sync/keys/modePin.ts
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
*     workspace;
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
var E2EE_MODE_PIN_PREFIX = "kmp-e2ee-mode:";
var isModePin = (value) => value === "e2ee" || value === "plaintext";
var hasLocalStorage = () => {
	try {
		return typeof window !== "undefined" && window.localStorage !== void 0;
	} catch {
		return false;
	}
};
var pinStorageKey = (userId, workspaceId) => `${E2EE_MODE_PIN_PREFIX}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;
var sessionPlaintext = /* @__PURE__ */ new Set();
var readPersistedPin = (key) => {
	if (!hasLocalStorage()) return null;
	try {
		const raw = localStorage.getItem(key);
		return isModePin(raw) ? raw : null;
	} catch {
		return null;
	}
};
/** The pinned mode for this (user, workspace) on this device, or null if
*  never pinned. A persisted pin wins; otherwise a session-only plaintext
*  confirmation (see {@link confirmPlaintextForSession}) counts as plaintext. */
var getModePin = (userId, workspaceId) => {
	const key = pinStorageKey(userId, workspaceId);
	return readPersistedPin(key) ?? (sessionPlaintext.has(key) ? "plaintext" : null);
};
/** Record a plaintext confirmation that couldn't be persisted (localStorage
*  unavailable), so {@link getModePin} reports plaintext for this session and
*  the user can load the workspace. Re-quarantines on next load. */
var confirmPlaintextForSession = (userId, workspaceId) => {
	sessionPlaintext.add(pinStorageKey(userId, workspaceId));
};
/** True if this device can durably persist mode pins (localStorage is writable).
*  E2EE REQUIRES this — the pin is the durable per-(user, workspace) mode
*  authority and the §6 gate keys off it — so the create flow preflights it
*  rather than minting an encrypted workspace this device could never open.
*  Plaintext doesn't need it (it has the session fallback). Probes with a temp
*  key and cleans up. */
var canPersistPins = () => {
	if (!hasLocalStorage()) return false;
	try {
		const probe = `${E2EE_MODE_PIN_PREFIX}__probe__`;
		localStorage.setItem(probe, "1");
		localStorage.removeItem(probe);
		return true;
	} catch {
		return false;
	}
};
/**
* Pin a workspace's mode. Set-once and locally immutable: re-pinning the
* same value is a no-op; attempting to pin a *different* value throws,
* because a mode flip is never legitimate (§6) and silently allowing it
* would be exactly the downgrade the pin exists to prevent.
*/
var setModePin = (userId, workspaceId, mode) => {
	const existing = getModePin(userId, workspaceId);
	if (existing === mode) return;
	if (existing !== null) throw new Error(`mode pin for (${userId}, ${workspaceId}) is immutable: ${existing} -> ${mode}`);
	if (!hasLocalStorage()) throw new Error("cannot set E2EE mode pin: localStorage unavailable");
	localStorage.setItem(pinStorageKey(userId, workspaceId), mode);
};
//#endregion
export { canPersistPins, confirmPlaintextForSession, getModePin, setModePin };

//# sourceMappingURL=modePin.js.map