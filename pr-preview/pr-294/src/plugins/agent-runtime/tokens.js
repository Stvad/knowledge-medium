import { hex } from "../../../node_modules/@scure/base/index.js";
import { clientLocalSettings } from "../../utils/ClientLocalSettings.js";
//#region src/plugins/agent-runtime/tokens.ts
/** Local-only registry of bridge auth tokens. A token authorizes
*  whoever holds it to drive the agent runtime bridge as if they were
*  this user, in this workspace, on this device. Stored in
*  localStorage (device-scoped, not synced) keyed by
*  (userId, workspaceId).
*
*  Tokens are stored in the clear: the security boundary is the
*  browser's same-origin model + the bridge listening on
*  127.0.0.1. Anyone who can read this localStorage already has the
*  user's session and can do anything from the running app. */
var KEY_PREFIX = "agent-runtime:tokens";
var storageKey = (userId, workspaceId) => `${KEY_PREFIX}:${userId}:${workspaceId}`;
var generateSecret = () => {
	if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
		const bytes = new Uint8Array(32);
		crypto.getRandomValues(bytes);
		return hex.encode(bytes);
	}
	let result = "";
	for (let i = 0; i < 64; i += 1) result += Math.floor(Math.random() * 16).toString(16);
	return result;
};
var AgentTokenStore = class {
	constructor(settings = clientLocalSettings) {
		this.settings = settings;
	}
	list(userId, workspaceId) {
		if (!userId || !workspaceId) return [];
		const tokens = this.settings.get(storageKey(userId, workspaceId), []);
		return Array.isArray(tokens) ? tokens : [];
	}
	create(userId, workspaceId, label, scope = "read-write") {
		if (!userId) throw new Error("userId required");
		if (!workspaceId) throw new Error("workspaceId required");
		const trimmedLabel = label.trim() || "agent";
		const tokens = this.list(userId, workspaceId);
		const token = {
			token: generateSecret(),
			label: trimmedLabel,
			scope,
			createdAt: Date.now(),
			lastSeenAt: null
		};
		this.settings.set(storageKey(userId, workspaceId), [...tokens, token]);
		return token;
	}
	revoke(userId, workspaceId, token) {
		const tokens = this.list(userId, workspaceId);
		const next = tokens.filter((t) => t.token !== token);
		if (next.length === tokens.length) return;
		if (next.length === 0) this.settings.remove(storageKey(userId, workspaceId));
		else this.settings.set(storageKey(userId, workspaceId), next);
	}
	touch(userId, workspaceId, token) {
		const tokens = this.list(userId, workspaceId);
		let changed = false;
		const next = tokens.map((t) => {
			if (t.token !== token) return t;
			changed = true;
			return {
				...t,
				lastSeenAt: Date.now()
			};
		});
		if (changed) this.settings.set(storageKey(userId, workspaceId), next);
	}
};
var agentTokenStore = new AgentTokenStore();
var agentTokensChangedEvent = "agent-runtime-bridge:tokens-changed";
/** Notify any listeners (e.g. the bridge hook) that the persisted
*  token set changed and registration should be re-sent. */
var notifyAgentTokensChanged = () => {
	window.dispatchEvent(new CustomEvent(agentTokensChangedEvent));
};
//#endregion
export { AgentTokenStore, agentTokenStore, agentTokensChangedEvent, notifyAgentTokensChanged };

//# sourceMappingURL=tokens.js.map