import { getModePin } from "./modePin.js";
import { getWorkspaceKeyStore } from "./keyStore.js";
import { decideWorkspaceEntry } from "./workspaceAccess.js";
//#region src/sync/keys/resolveWorkspaceEntry.ts
/**
* §6 rule 3 access gate — the *read-inputs* half, reunited with the *decide*
* half ({@link decideWorkspaceEntry}) it feeds.
*
* The bootstrap pipeline must know, BEFORE any plaintext write, whether the
* active workspace can be materialized for us right now. That needs three live
* reads — the local mode pin, the per-device workspace key, and the local
* `workspaces` row — gathered here and handed to the pure policy in
* `workspaceAccess.ts`. The workspace-row read is the one cross-layer dependency
* (the data layer), so it is injected via {@link loadWorkspace} rather than
* imported, keeping this module within `sync/keys`.
*/
/**
* Resolve how to enter `workspaceId` for `userId`: gather the pin, key, and
* (injected) local workspace row, then defer to {@link decideWorkspaceEntry}.
*
* Only an e2ee pin actually uses the workspace key. Reading the key store for
* plaintext/unpinned workspaces is unnecessary and — if IndexedDB is
* unavailable (private mode, disabled/corrupt storage) — would block an
* otherwise-plaintext user from loading the app. A read failure is treated as
* "no key" (→ locked, key-required) rather than aborting the bootstrap.
*/
var resolveWorkspaceEntry = async (userId, workspaceId, loadWorkspace) => {
	const pin = getModePin(userId, workspaceId);
	let hasKey = false;
	if (pin === "e2ee") try {
		const record = await getWorkspaceKeyStore().get(userId, workspaceId);
		hasKey = record !== null && record.contentKeyHmac !== null;
	} catch (err) {
		console.warn(`[App] workspace key read failed for ${workspaceId}; treating as locked`, err);
	}
	const workspace = await loadWorkspace(workspaceId);
	const entry = decideWorkspaceEntry(pin, hasKey, workspace);
	if (entry.kind === "locked") return {
		kind: "locked",
		reason: entry.reason,
		workspaceName: workspace?.name ?? null,
		canary: workspace?.wkCanary ?? null
	};
	return entry;
};
//#endregion
export { resolveWorkspaceEntry };

//# sourceMappingURL=resolveWorkspaceEntry.js.map