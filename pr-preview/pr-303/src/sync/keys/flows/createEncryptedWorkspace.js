import { canPersistPins, setModePin } from "../modePin.js";
import { mintCanary, validateCanary } from "../../crypto/canary.js";
import { deriveContentKeyHmac } from "../../crypto/contentKey.js";
import { formatWorkspaceKey, generateWorkspaceKeyBytes, importWorkspaceKey, parseWorkspaceKey } from "../../crypto/workspaceKey.js";
//#region src/sync/keys/flows/createEncryptedWorkspace.ts
/**
* §8.1 — create an encrypted workspace (the key-minting flow).
*
* The one flow that brings an E2EE workspace into existence: it generates the
* workspace key (WK), mints the canary the server stores, creates the server
* row, and — only after the server row exists — persists the WK on this device
* and pins the workspace `e2ee` (§6 rule 1). It returns the `kmp-wk-1:` string
* to show the user ONCE; no WK bytes are ever sent to the server (only the
* canary, which is opaque ciphertext).
*
* Decoupled from the data layer by construction: the workspace-create RPC is
* INJECTED (`deps.createWorkspace`) and the flow only owns crypto + key store +
* pin. It passes the RPC's result straight through (spread onto the return), so
* it never needs to know the workspace row's shape — the UI gets
* `CreatedWorkspace & { workspaceKey }`.
*/
var KEY_STORE_PROBE_ID = "__e2ee_keystore_probe__";
var createEncryptedWorkspace = async (name, deps) => {
	if (!canPersistPins()) throw new Error("Encrypted workspaces need browser storage that is currently unavailable (private mode or storage disabled). You can still create a regular workspace.");
	const workspaceId = (deps.newWorkspaceId ?? (() => crypto.randomUUID()))();
	const keyBytes = (deps.generateKeyBytes ?? generateWorkspaceKeyBytes)();
	const workspaceKey = formatWorkspaceKey(keyBytes);
	let cryptoKey;
	let contentKeyHmac;
	try {
		cryptoKey = await importWorkspaceKey(keyBytes);
		contentKeyHmac = await deriveContentKeyHmac(keyBytes);
	} finally {
		keyBytes.fill(0);
	}
	const wkCanary = await mintCanary(cryptoKey, workspaceId);
	const verifyBytes = parseWorkspaceKey(workspaceKey);
	let verifyKey;
	try {
		verifyKey = await importWorkspaceKey(verifyBytes);
	} finally {
		verifyBytes.fill(0);
	}
	if (!await validateCanary(verifyKey, wkCanary, workspaceId)) throw new Error("createEncryptedWorkspace: minted canary failed round-trip self-validation");
	try {
		await deps.keyStore.put(deps.userId, KEY_STORE_PROBE_ID, {
			wk: cryptoKey,
			contentKeyHmac
		});
		await deps.keyStore.delete(deps.userId, KEY_STORE_PROBE_ID);
	} catch {
		throw new Error("Encrypted workspaces need browser storage that is currently unavailable (private mode or storage limits). You can still create a regular workspace.");
	}
	const created = await deps.createWorkspace(name, {
		encryptionMode: "e2ee",
		workspaceId,
		wkCanary
	});
	try {
		setModePin(deps.userId, workspaceId, "e2ee");
	} catch (err) {
		console.warn(`createEncryptedWorkspace: mode-pin write failed for ${workspaceId}; the workspace will prompt for the saved WK on next load`, err);
	}
	try {
		await deps.keyStore.put(deps.userId, workspaceId, {
			wk: cryptoKey,
			contentKeyHmac
		});
	} catch (err) {
		console.warn(`createEncryptedWorkspace: key store write failed for ${workspaceId}; workspace is locked until the saved WK is re-pasted`, err);
	}
	return {
		...created,
		workspaceKey
	};
};
//#endregion
export { createEncryptedWorkspace };

//# sourceMappingURL=createEncryptedWorkspace.js.map