import { canaryAad } from "./aad.js";
import { open, seal } from "./aead.js";
//#region src/sync/crypto/canary.ts
/**
* Workspace key-check canary (§7/§8).
*
* The canary is an AEAD-sealed known plaintext — the workspace id —
* stored in `workspaces.wk_canary`. Decrypting it with a candidate WK
* both authenticates the key (AEAD failure = wrong key) and confirms it
* is bound to THIS workspace (right key on another workspace's canary
* fails the plaintext-equals-id check). It validates a pasted WK even on
* a workspace that has no blocks yet (freshly invited or just created).
*/
/** Mint the canary for a new E2EE workspace (§8.1). */
var mintCanary = (key, workspaceId) => seal(key, workspaceId, canaryAad(workspaceId));
/** Validate a candidate WK against a workspace's stored canary (§8.2).
*  Returns false on AEAD failure (wrong key) or plaintext mismatch
*  (right key, wrong workspace) — never throws for a bad key. */
var validateCanary = async (key, canary, workspaceId) => {
	try {
		return await open(key, canary, canaryAad(workspaceId)) === workspaceId;
	} catch {
		return false;
	}
};
//#endregion
export { mintCanary, validateCanary };

//# sourceMappingURL=canary.js.map