import { getModePin } from "./modePin.js";
//#region src/sync/keys/resolver.ts
var createSyncResolver = (getUserId, keyStore) => {
	const getCek = async (workspaceId) => {
		const userId = getUserId();
		if (!userId) return null;
		try {
			return (await keyStore.get(userId, workspaceId))?.wk ?? null;
		} catch (err) {
			console.warn(`[syncResolver] key read failed for ${workspaceId}; treating as no key`, err);
			return null;
		}
	};
	const getContentKeyHmac = async (workspaceId) => {
		const userId = getUserId();
		if (!userId) return null;
		try {
			return (await keyStore.get(userId, workspaceId))?.contentKeyHmac ?? null;
		} catch (err) {
			console.warn(`[syncResolver] K_id read failed for ${workspaceId}; treating as absent`, err);
			return null;
		}
	};
	const getMaterializability = async (workspaceId) => {
		const userId = getUserId();
		if (!userId) return "defer";
		const pin = getModePin(userId, workspaceId);
		if (pin === "plaintext") return "copy";
		if (pin === "e2ee") return await getCek(workspaceId) ? "decrypt" : "defer";
		return "defer";
	};
	const getMode = async (workspaceId) => {
		const userId = getUserId();
		if (!userId) return "none";
		return getModePin(userId, workspaceId) === "e2ee" ? "e2ee" : "none";
	};
	return {
		getMaterializability,
		getCek,
		getContentKeyHmac,
		getMode
	};
};
//#endregion
export { createSyncResolver };

//# sourceMappingURL=resolver.js.map