//#region src/sync/keys/workspaceAccess.ts
var resolveWorkspaceAccess = (pin, serverEncryptionMode, hasKey) => {
	if (pin === "plaintext") return { kind: "ready" };
	if (pin === "e2ee") return hasKey ? { kind: "ready" } : {
		kind: "locked",
		reason: "key-required"
	};
	return serverEncryptionMode === "e2ee" ? {
		kind: "locked",
		reason: "key-required"
	} : {
		kind: "locked",
		reason: "quarantine"
	};
};
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
var decideWorkspaceEntry = (pin, hasKey, row) => {
	if (!(pin === "plaintext" || pin === "e2ee" && hasKey) && row === null) return { kind: "waiting" };
	return resolveWorkspaceAccess(pin, row?.encryptionMode ?? "none", hasKey);
};
//#endregion
export { decideWorkspaceEntry };

//# sourceMappingURL=workspaceAccess.js.map