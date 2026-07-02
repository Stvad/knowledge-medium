import { FacetRuntime, pushValidatedContribution, walkAppExtension, walkAppExtensionSync } from "./facet.js";
import { getBoundary, isEnabled } from "./togglable.js";
//#region src/facets/resolveAppRuntime.ts
/**
* Boundary-aware FacetRuntime resolver.
*
* A thin configuration of the shared `walkAppExtension` skeleton (see
* `facet.ts`) adding two behaviours the bare collector visitor doesn't:
*
*   1. `getBoundary(node)` on an array → look up `isEnabled(handle,
*      overrides)`; skip the whole subtree when the toggle resolves
*      to off. Essentials are forced on; non-essentials honour the
*      overrides map, falling back to `defaultEnabled ?? true`.
*
*   2. Recurse into `FacetContribution.enables` (a slice-7 field on
*      `FacetContributionOptions`) only when the parent contribution
*      itself passed validation — dragged-along extensions exist to
*      support their parent and are dropped when the parent is.
*
* Both behaviours live in `resolverVisitor` and apply identically across
* the sync and async walks. The async walk additionally awaits
* function-valued AppExtensions; the sync walk throws on them, matching
* the shared walker's policy.
*
* facet.ts has no awareness of `@/facets/togglable.ts`; this module
* is the only place the two meet. Anyone calling `resolveFacetRuntime`
* directly still gets the bare behaviour — which is fine for the unit
* tests that don't care about toggle semantics. Production wiring goes
* through `resolveAppRuntime` / `resolveAppRuntimeSync` here.
*/
/** Resolver-internal gate: should this boundary's subtree be walked?
*  Wraps `isEnabled` with the safe-mode override. Kept separate from
*  `isEnabled` so that module stays pure (handle + overrides → boolean) —
*  UI callers reading "what's the user's preference?" want the bare
*  predicate; only the resolver applies the recovery override. */
var shouldKeepBoundary = (handle, overrides, safeMode) => {
	if (handle.essential) return true;
	if (safeMode) return false;
	return isEnabled(handle, overrides);
};
/** The only thing the resolver adds to the shared walker: a togglable
*  boundary array is pruned when its handle resolves to off, and a
*  contribution recurses into `enables` only if it survived validation
*  (dragged-along extensions exist to support their parent and are
*  dropped when the parent is). `output` is the threaded sink. */
var resolverVisitor = (overrides, safeMode) => ({
	array: (node, output) => {
		const handle = getBoundary(node);
		if (handle && !shouldKeepBoundary(handle, overrides, safeMode)) return null;
		return output;
	},
	contribution: (node, output) => pushValidatedContribution(node, output) ? output : null
});
/** Build a FacetRuntime from an AppExtension tree, evaluating toggle
*  boundaries with the supplied overrides. Async — awaits any
*  function-valued nodes (e.g. `dynamicExtensionsExtension`). */
async function resolveAppRuntime(extensions, options) {
	const context = options.context ?? {};
	const safeMode = options.safeMode ?? false;
	const collected = [];
	await walkAppExtension(extensions, collected, resolverVisitor(options.overrides, safeMode), {
		context,
		seen: /* @__PURE__ */ new Set()
	});
	return new FacetRuntime(context, collected);
}
/** Sync variant. Throws if a function-valued AppExtension is reached.
*  The static extension tree contains no functions today;
*  `AppRuntimeProvider` relies on that for first-paint resolution before
*  React can await. */
function resolveAppRuntimeSync(extensions, options) {
	const context = options.context ?? {};
	const safeMode = options.safeMode ?? false;
	const collected = [];
	walkAppExtensionSync(extensions, collected, resolverVisitor(options.overrides, safeMode), {
		onFunction: "resolveAppRuntimeSync: cannot resolve function-valued AppExtension. Use resolveAppRuntime (async) for trees that contain dynamic extensions.",
		seen: /* @__PURE__ */ new Set()
	});
	return new FacetRuntime(context, collected);
}
//#endregion
export { resolveAppRuntime, resolveAppRuntimeSync };

//# sourceMappingURL=resolveAppRuntime.js.map