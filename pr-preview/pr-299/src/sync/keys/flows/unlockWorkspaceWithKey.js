import { setModePin } from "../modePin.js";
import { validateCanary } from "../../crypto/canary.js";
import { deriveContentKeyHmac } from "../../crypto/contentKey.js";
import { importWorkspaceKey, parseWorkspaceKey } from "../../crypto/workspaceKey.js";
//#region src/sync/keys/flows/unlockWorkspaceWithKey.ts
/**
* §8.2 — open an E2EE workspace with a pasted workspace key (WK).
*
* The flow that turns a pasted `kmp-wk-1:` string into a usable, pinned
* workspace on this device. It validates the candidate WK against the
* workspace's stored `wk_canary` (AEAD failure = wrong key; plaintext mismatch =
* right key, wrong workspace — both reject), and only on success imports the WK
* into the key store and pins the workspace `e2ee` (§6 rule 1).
*
* Covers two entry points with one path:
*   - first encounter on a new device / accepted invite (the key-required
*     branch (a), or the quarantine branch (b) where pasting a valid WK defeats
*     a server downgrade lie — §6 rule 3);
*   - re-unlocking a workspace already pinned `e2ee` whose WK is absent on this
*     device (re-pinning the same value is a no-op).
*
* Pure of UI and DB: the canary comes in as a string and the key store is
* injected. The caller (Phase E UI) supplies `workspaces.wk_canary` and, on
* success, re-materializes the workspace via the observer's `drainWorkspace`.
*/
var unlockWorkspaceWithKey = async (args) => {
	const { userId, workspaceId, canary, pastedKey, keyStore } = args;
	let key;
	let contentKeyHmac;
	try {
		const wkBytes = parseWorkspaceKey(pastedKey);
		try {
			key = await importWorkspaceKey(wkBytes);
			contentKeyHmac = await deriveContentKeyHmac(wkBytes);
		} finally {
			wkBytes.fill(0);
		}
	} catch {
		return {
			ok: false,
			reason: "format"
		};
	}
	if (!await validateCanary(key, canary, workspaceId)) return {
		ok: false,
		reason: "invalid-key"
	};
	try {
		setModePin(userId, workspaceId, "e2ee");
		await keyStore.put(userId, workspaceId, {
			wk: key,
			contentKeyHmac
		});
	} catch (err) {
		console.warn(`unlockWorkspaceWithKey: persisting unlock failed for ${workspaceId}`, err);
		return {
			ok: false,
			reason: "storage"
		};
	}
	return { ok: true };
};
//#endregion
export { unlockWorkspaceWithKey };

//# sourceMappingURL=unlockWorkspaceWithKey.js.map