//#region src/plugins/video-player/registry.ts
var SCOPELESS = "";
var registry = /* @__PURE__ */ new Map();
var registerVideoPlayer = (blockId, renderScopeId, handle) => {
	const scopeKey = renderScopeId ?? SCOPELESS;
	let byScope = registry.get(blockId);
	if (!byScope) {
		byScope = /* @__PURE__ */ new Map();
		registry.set(blockId, byScope);
	}
	byScope.set(scopeKey, handle);
	return () => {
		const current = registry.get(blockId);
		if (!current) return;
		if (current.get(scopeKey) === handle) current.delete(scopeKey);
		if (current.size === 0) registry.delete(blockId);
	};
};
var resolveVideoPlayer = (blockId, renderScopeId) => {
	const byScope = registry.get(blockId);
	if (!byScope) return void 0;
	if (renderScopeId !== void 0) {
		const scoped = byScope.get(renderScopeId);
		if (scoped) return scoped;
	}
	return byScope.values().next().value;
};
var requestCurrentTime = (blockId, renderScopeId) => resolveVideoPlayer(blockId, renderScopeId)?.getCurrentTime();
var requestVideoPlayerFocus = (blockId, renderScopeId) => resolveVideoPlayer(blockId, renderScopeId)?.focus() ?? false;
var isVideoPlayerFocusActive = (blockId, renderScopeId) => resolveVideoPlayer(blockId, renderScopeId)?.hasFocus() ?? false;
var seekTo = (seconds, blockId, renderScopeId) => resolveVideoPlayer(blockId, renderScopeId)?.seekTo(seconds);
//#endregion
export { isVideoPlayerFocusActive, registerVideoPlayer, requestCurrentTime, requestVideoPlayerFocus, seekTo };

//# sourceMappingURL=registry.js.map