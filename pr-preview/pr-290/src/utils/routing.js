//#region src/utils/routing.ts
var flattenSlots = (slots) => slots.flatMap((slot) => slot.kind === "leaf" ? [slot.blockId] : flattenSlots(slot.children));
var splitHashRouteAndParams = (hash) => {
	const raw = hash ?? "";
	const trimmed = raw.startsWith("#") ? raw.slice(1) : raw;
	const queryIndex = trimmed.indexOf("?");
	return {
		route: queryIndex >= 0 ? trimmed.slice(0, queryIndex) : trimmed,
		params: new URLSearchParams(queryIndex >= 0 ? trimmed.slice(queryIndex + 1) : "")
	};
};
var buildHashWithParams = (route, params) => {
	const query = params.toString();
	if (!route && !query) return "";
	return `#${route}${query ? `?${query}` : ""}`;
};
var preserveHashQueryParams = (nextHash, currentHash) => {
	const next = splitHashRouteAndParams(nextHash);
	const current = splitHashRouteAndParams(currentHash);
	const merged = new URLSearchParams(next.params);
	const nextKeys = new Set(merged.keys());
	current.params.forEach((value, key) => {
		if (!nextKeys.has(key)) merged.append(key, value);
	});
	return buildHashWithParams(next.route, merged);
};
var splitTopLevel = (input, separator) => {
	const out = [];
	let depth = 0;
	let start = 0;
	for (let index = 0; index < input.length; index++) {
		const char = input[index];
		if (char === "(") depth++;
		if (char === ")") depth = Math.max(0, depth - 1);
		if (char === separator && depth === 0) {
			out.push(input.slice(start, index));
			start = index + 1;
		}
	}
	out.push(input.slice(start));
	return out;
};
var parseSlot = (raw) => {
	const token = raw.trim();
	if (!token) return null;
	if (token.startsWith("(s:") && token.endsWith(")")) return {
		kind: "stack",
		children: splitTopLevel(token.slice(3, -1), ",").map(parseSlot).filter((slot) => Boolean(slot))
	};
	return {
		kind: "leaf",
		blockId: token
	};
};
var parseLayout = (hash) => {
	if (!hash) return {
		slots: [],
		blockIds: []
	};
	const trimmed = splitHashRouteAndParams(hash).route;
	if (!trimmed) return {
		slots: [],
		blockIds: []
	};
	const [workspaceId, ...slotTokens] = splitTopLevel(trimmed, "/");
	const slots = slotTokens.map(parseSlot).filter((slot) => Boolean(slot));
	return {
		workspaceId: workspaceId || void 0,
		slots,
		blockIds: flattenSlots(slots)
	};
};
var buildLayout = (workspaceId, blockIds = []) => blockIds.length > 0 ? `#${workspaceId}/${blockIds.join("/")}` : `#${workspaceId}`;
var buildLayoutSlot = (slot) => {
	if (slot.kind === "leaf") return slot.blockId;
	return `(s:${slot.children.map(buildLayoutSlot).join(",")})`;
};
var buildLayoutFromSlots = (workspaceId, slots = []) => slots.length > 0 ? `#${workspaceId}/${slots.map(buildLayoutSlot).join("/")}` : `#${workspaceId}`;
var layoutWorkspaceChanged = (previousHash, nextHash) => parseLayout(previousHash).workspaceId !== parseLayout(nextHash).workspaceId;
var parseAppHash = (hash) => {
	const { workspaceId, blockIds } = parseLayout(hash);
	if (!workspaceId) return {};
	return {
		workspaceId,
		blockId: blockIds[0]
	};
};
var buildAppHash = (workspaceId, blockId) => buildLayout(workspaceId, blockId ? [blockId] : []);
/**
* Promote an app hash (from `buildAppHash` / `buildLayout` /
* `buildLayoutFromSlots`) to an absolute, shareable URL:
* `<origin><pathname><hash>`.
*
* In-app `<a href>` links can use the bare hash directly — the browser
* resolves it against the current document. A URL meant to leave the app
* (copied to the clipboard, shared) has to be absolute, which is what this
* adds.
*
* Uses origin+pathname only, deliberately dropping the current query
* string and existing hash. The live hash can carry the agent-runtime
* pairing secret (`#…?agent-runtime-secret=…`, consumed by the agent
* bridge); replacing the whole hash guarantees it never rides along in a
* link the user shares. In a non-browser context (SSR/tests) there is no
* location to resolve against, so the bare hash is returned unchanged.
*/
var absoluteAppUrl = (hash) => typeof window === "undefined" ? hash : `${window.location.origin}${window.location.pathname}${hash}`;
//#endregion
export { absoluteAppUrl, buildAppHash, buildLayout, buildLayoutFromSlots, layoutWorkspaceChanged, parseAppHash, parseLayout, preserveHashQueryParams };

//# sourceMappingURL=routing.js.map