//#region src/facets/togglable.ts
var BOUNDARY = Symbol("togglable.boundary");
function markBoundary(handle, ext) {
	const wrapped = [ext];
	Object.defineProperty(wrapped, BOUNDARY, {
		value: handle,
		enumerable: false
	});
	return wrapped;
}
/** Read the boundary handle stored on an array, or undefined if the
*  node isn't a togglable boundary. */
function getBoundary(node) {
	if (!node || typeof node !== "object") return void 0;
	return node[BOUNDARY];
}
/** Restore the boundary marker on an array produced by `.map()` or
*  similar (which always returns a fresh array, dropping non-enumerable
*  symbols). Used by `validateAndPrefix` so user-extension boundaries
*  survive normalisation. Exported as the canonical way to attach a
*  boundary to an existing array; do not redefine the symbol externally. */
function attachBoundary(target, handle) {
	Object.defineProperty(target, BOUNDARY, {
		value: handle,
		enumerable: false,
		configurable: true
	});
}
function systemToggle(opts) {
	const handle = {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		essential: opts.essential,
		defaultEnabled: opts.defaultEnabled,
		kind: "system",
		of: (ext) => markBoundary(handle, ext)
	};
	return handle;
}
/** User-extension toggle: `essential` and `kind` are fixed, and
*  `defaultEnabled` is forced to `false` so an extension's module code
*  never runs until an explicit `true` override opts it in. Unlike
*  `systemToggle`, the display metadata is supplied by the caller rather
*  than read here — see `UserToggleOptions`. */
function userToggle(opts) {
	const handle = {
		id: opts.id,
		name: opts.name,
		description: opts.description,
		essential: false,
		defaultEnabled: false,
		kind: "user",
		of: (ext) => markBoundary(handle, ext)
	};
	return handle;
}
function isEnabled(handle, overrides) {
	if (handle.essential) return true;
	const override = overrides.get(handle.id);
	if (override !== void 0) return override;
	return handle.defaultEnabled ?? true;
}
/** UI toggle convention. Returns a new overrides map; comparing
*  against `defaultEnabled ?? true` keeps the map free of entries that
*  match the manifest default. */
function applyToggle(overrides, handle, nextState) {
	const next = new Map(overrides);
	if (nextState === (handle.defaultEnabled ?? true)) next.delete(handle.id);
	else next.set(handle.id, nextState);
	return next;
}
//#endregion
export { applyToggle, attachBoundary, getBoundary, isEnabled, systemToggle, userToggle };

//# sourceMappingURL=togglable.js.map