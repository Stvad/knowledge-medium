import { CallbackSet } from "../../utils/callbackSet.js";
//#region src/plugins/claude-tasks-companion/askedStore.ts
/**
* Ephemeral "asked Claude" marks — instant chip feedback between the
* Ask Claude action and the daemon's claim (which replaces the mark
* with real `claude:status` props). Local-only by design: the graph
* carries the authoritative lifecycle; this is just optimistic UI.
*/
/** A mark the daemon never answers (daemon down, watcher missing)
*  quietly expires instead of showing "queued" forever. */
var ASKED_TTL_MS = 6e4;
var askedAt = /* @__PURE__ */ new Map();
var changed = new CallbackSet("claude-tasks-asked");
var markAskedClaude = (blockId) => {
	askedAt.set(blockId, Date.now());
	changed.notify();
};
var clearAskedClaude = (blockId) => {
	if (askedAt.delete(blockId)) changed.notify();
};
var isAskedClaude = (blockId) => {
	const at = askedAt.get(blockId);
	if (at === void 0) return false;
	if (Date.now() - at > ASKED_TTL_MS) {
		askedAt.delete(blockId);
		return false;
	}
	return true;
};
var subscribeAskedClaude = (listener) => changed.add(listener);
//#endregion
export { clearAskedClaude, isAskedClaude, markAskedClaude, subscribeAskedClaude };

//# sourceMappingURL=askedStore.js.map