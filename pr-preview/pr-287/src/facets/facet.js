//#region src/facets/facet.ts
var isFunction = (value) => typeof value === "function";
var resolveLastContributionResult = (contributions, context, initialValue) => {
	let result = initialValue;
	for (const contribution of contributions) {
		const contributionResult = contribution(context);
		if (contributionResult) result = contributionResult;
	}
	return result;
};
var combineLastContributionResult = (getInitialValue) => (contributions) => (context) => resolveLastContributionResult(contributions, context, getInitialValue?.(context));
function defineFacet({ id, combine, empty, validate }) {
	const facet = {
		id,
		combine: combine ?? ((values) => values),
		empty: empty ?? (() => []),
		validate,
		of: (value, options = {}) => ({
			type: "facet-contribution",
			facet,
			value,
			...options
		})
	};
	return facet;
}
/** Define a facet whose contributions fold into a `ReadonlyMap` keyed
*  by `keyOf`. Duplicate keys log a last-wins warning (tagged with the
*  facet id) and the later contribution wins — the §6 registry
*  convention shared by every data-layer registry facet (mutators,
*  queries, types, presets, …). See `src/data/facets.ts`. */
function keyedMapFacet(id, keyOf) {
	return defineFacet({
		id,
		combine: (values) => {
			const out = /* @__PURE__ */ new Map();
			for (const value of values) {
				const key = keyOf(value);
				if (out.has(key)) console.warn(`[${id}] duplicate registration for "${key}"; last-wins per facet convention`);
				out.set(key, value);
			}
			return out;
		},
		empty: () => /* @__PURE__ */ new Map()
	});
}
/** Reusable `combine` for an **id-bearing list facet** — one whose
*  `Input` carries a logical `id` and whose consumers iterate the output
*  as an array, rendering/keying one element per entry by that id
*  (`appMountsFacet`, `panelMountsFacet`, `headerItemsFacet`). The
*  default keep-all combine is WRONG for these: unlike a reference-stable
*  singleton data/schema extension, mounts are contributed inside plugin
*  factories, so each call mints a fresh `FacetContribution` and the
*  resolver's identity dedup (`seen` set in `walkAppExtension`) never
*  fires. Two code paths contributing the same logical `id` would then
*  BOTH render — two components, two `addEventListener`s, one dispatch
*  handled twice (the #64 double-mount trap). This collapses duplicates
*  to a single survivor while keeping the output a `readonly Input[]` —
*  use `keyedMapFacet` instead when the consumer wants a `ReadonlyMap`.
*
*  `keyOf` defaults to the logical `id`, which is right when the consumer
*  renders the whole output as one keyed list. Pass a composite key when
*  the consumer FIRST partitions the list and keys each partition
*  separately — e.g. `headerItemsFacet` splits into `start`/`end` regions
*  with React keys scoped inside each region (`Header.tsx`), so its dedup
*  key is `${region}:${id}`: same id in two different regions is NOT a
*  collision and both must survive. The key must mirror the consumer's
*  render-key scope, or this either over-collapses (drops a legit entry)
*  or under-collapses (lets a real double-render through).
*
*  Tie-break — LAST-WINS, precedence-ordered. `FacetRuntime.read` sorts
*  contributions ascending by `precedence` (default 0, then registration
*  order) before calling `combine`, so when two survive with the same
*  key the later one — higher precedence, or later registration at equal
*  precedence — replaces the earlier. This matches the repo-wide §6
*  registry convention (`keyedMapFacet`, the effects reconciler in
*  `liveRuntime.ts`) whose documented override idiom is "register after
*  to replace"; a silent first-wins would drop that override with no
*  signal. First-occurrence position is preserved in the output (an
*  override updates in place rather than moving to the end), so dedup
*  never reshuffles render order.
*
*  A same-key collision is a misconfiguration even when the tie-break is
*  "fine" (it's what made bundling the reschedule-picker mount unsafe in
*  #63/#64), so each displacement logs a warning naming the facet + key.
*
*  NOT appropriate for `actionsFacet` (keyed by `context:id` downstream —
*  the same id legitimately appears in multiple contexts) or
*  `appEffectsFacet` (the liveRuntime reconciler already dedups it by id,
*  because it owns the effect start/stop lifecycle). */
var dedupById = (facetId, keyOf = (value) => value.id) => (values) => {
	const byKey = /* @__PURE__ */ new Map();
	for (const value of values) {
		const key = keyOf(value);
		if (byKey.has(key)) console.warn(`[${facetId}] duplicate contribution for key "${key}"; collapsed to a single entry (last-wins per facet convention)`);
		byKey.set(key, value);
	}
	return [...byKey.values()];
};
/** NOTE: `LiveRuntimeHandle` (src/extensions/liveRuntime.ts) subclasses
*  this and overrides EVERY public method to delegate to a swappable
*  `current` runtime — its inherited storage is intentionally dead. A new
*  public method added here that the handle doesn't override would
*  silently serve that empty inherited state for effect callers (no type
*  error). Add the override there too. */
var FacetRuntime = class {
	staticContributionsByFacet = /* @__PURE__ */ new Map();
	runtimeContributionsByFacet = /* @__PURE__ */ new Map();
	/** Per-facet set of runtime source ids marked **durable** — i.e.
	*  written with `{durable: true}`. Durable buckets are repo-owned
	*  user data (user property schemas / types) that must survive a
	*  `setFacetRuntime` swap; `adoptDurableContributionsFrom` copies only
	*  these forward onto the fresh runtime. Transient buckets (effect-
	*  owned outputs such as the theme apply-actions or keybinding
	*  overrides) are NOT tracked here — their owning effect re-pushes
	*  them on restart, so replaying them would strand stale entries when
	*  the effect's plugin is toggled off (the bug that reverted the
	*  literal `withContributionsFrom` in #152). */
	durableRuntimeSources = /* @__PURE__ */ new Map();
	cache = /* @__PURE__ */ new Map();
	facetListeners = /* @__PURE__ */ new Map();
	constructor(context, contributions) {
		this.context = context;
		for (const contribution of contributions) {
			const bucket = this.staticContributionsByFacet.get(contribution.facet.id) ?? [];
			bucket.push(contribution);
			this.staticContributionsByFacet.set(contribution.facet.id, bucket);
		}
	}
	collectContributions(facetId) {
		const stat = this.staticContributionsByFacet.get(facetId) ?? [];
		const runtime = this.runtimeContributionsByFacet.get(facetId);
		if (!runtime || runtime.size === 0) return stat;
		const out = [...stat];
		for (const bucket of runtime.values()) out.push(...bucket);
		return out;
	}
	read(facet) {
		if (this.cache.has(facet.id)) return this.cache.get(facet.id);
		const contributions = this.collectContributions(facet.id);
		if (!contributions.length) {
			const emptyValue = facet.empty(this.context);
			this.cache.set(facet.id, emptyValue);
			return emptyValue;
		}
		const values = contributions.toSorted((a, b) => (a.precedence ?? 0) - (b.precedence ?? 0)).map((contribution) => contribution.value);
		const value = facet.combine(values, this.context);
		this.cache.set(facet.id, value);
		return value;
	}
	/** Replace the runtime contributions bucket for this facet under
	*  `sourceId`. Empty `contributions` removes the bucket. Notifies
	*  per-facet subscribers after the cache is invalidated.
	*
	*  `options.durable` (default false) marks the bucket as repo-owned
	*  user data that must survive `setFacetRuntime` swaps — see
	*  `adoptDurableContributionsFrom` / `durableRuntimeSources`. Effect-
	*  owned (transient) writers omit it. */
	setRuntimeContributions(facet, sourceId, contributions, options) {
		const wrapped = contributions.map((value) => ({
			type: "facet-contribution",
			facet,
			value,
			source: sourceId
		}));
		const existing = this.runtimeContributionsByFacet.get(facet.id) ?? /* @__PURE__ */ new Map();
		if (wrapped.length === 0) {
			existing.delete(sourceId);
			if (existing.size === 0) this.runtimeContributionsByFacet.delete(facet.id);
			else this.runtimeContributionsByFacet.set(facet.id, existing);
			this.unmarkDurable(facet.id, sourceId);
		} else {
			existing.set(sourceId, wrapped);
			this.runtimeContributionsByFacet.set(facet.id, existing);
			if (options?.durable) this.markDurable(facet.id, sourceId);
			else this.unmarkDurable(facet.id, sourceId);
		}
		this.cache.delete(facet.id);
		this.notifyFacetListeners(facet.id);
	}
	markDurable(facetId, sourceId) {
		const set = this.durableRuntimeSources.get(facetId) ?? /* @__PURE__ */ new Set();
		set.add(sourceId);
		this.durableRuntimeSources.set(facetId, set);
	}
	unmarkDurable(facetId, sourceId) {
		const set = this.durableRuntimeSources.get(facetId);
		if (!set) return;
		set.delete(sourceId);
		if (set.size === 0) this.durableRuntimeSources.delete(facetId);
	}
	/** Copy the **durable** runtime-contribution buckets from `previous`
	*  onto this (fresh) runtime, preserving their durability marks, so
	*  repo-owned user data (user property schemas / types) survives a
	*  `setFacetRuntime` swap without a separate Repo-side mirror. This is
	*  the sound realization of B1(2) "make replay the runtime's job":
	*  only durable buckets are carried forward, so transient effect-owned
	*  buckets can't strand. Caches for the touched facets are
	*  invalidated; no listeners fire (a fresh runtime has none yet — the
	*  bridge runs its rebuild steps after this call).
	*
	*  Carry-forward is unconditional, so a writer that owns a workspace-scoped
	*  durable bucket must clear it on teardown (see the ownership contract on
	*  `Repo.setRuntimeContributions`) — otherwise its data is adopted into the
	*  next workspace's runtime on the per-user Repo singleton. */
	adoptDurableContributionsFrom(previous) {
		for (const [facetId, durableSources] of previous.durableRuntimeSources) {
			const prevBuckets = previous.runtimeContributionsByFacet.get(facetId);
			if (!prevBuckets) continue;
			for (const sourceId of durableSources) {
				const bucket = prevBuckets.get(sourceId);
				if (!bucket || bucket.length === 0) continue;
				const buckets = this.runtimeContributionsByFacet.get(facetId) ?? /* @__PURE__ */ new Map();
				buckets.set(sourceId, bucket);
				this.runtimeContributionsByFacet.set(facetId, buckets);
				this.markDurable(facetId, sourceId);
				this.cache.delete(facetId);
			}
		}
	}
	/** Subscribe to changes for one facet. Fires after every
	*  setRuntimeContributions call that targets this facet. Static
	*  extension contributions don't fire this — they only change when
	*  the whole runtime is rebuilt. */
	onFacetChange(facetId, listener) {
		const set = this.facetListeners.get(facetId) ?? /* @__PURE__ */ new Set();
		set.add(listener);
		this.facetListeners.set(facetId, set);
		return () => {
			const current = this.facetListeners.get(facetId);
			if (!current) return;
			current.delete(listener);
			if (current.size === 0) this.facetListeners.delete(facetId);
		};
	}
	notifyFacetListeners(facetId) {
		const listeners = this.facetListeners.get(facetId);
		if (!listeners) return;
		for (const l of [...listeners]) try {
			l();
		} catch (err) {
			console.error(`[FacetRuntime] facet listener for ${facetId} threw`, err);
		}
	}
	contributions(facet) {
		return this.collectContributions(facet.id);
	}
	/**
	* Every facet id that has at least one contribution (static or
	* runtime). Useful for introspection (agent bridge describeRuntime,
	* debug pages).
	*/
	facetIds() {
		const ids = /* @__PURE__ */ new Set();
		for (const id of this.staticContributionsByFacet.keys()) ids.add(id);
		for (const id of this.runtimeContributionsByFacet.keys()) ids.add(id);
		return Array.from(ids);
	}
	/**
	* Raw contributions for a facet, looked up by id rather than by
	* facet object. Lets introspection callers enumerate without
	* needing the original Facet definition in scope.
	*/
	contributionsById(facetId) {
		return this.collectContributions(facetId);
	}
};
function resolveFacetRuntimeSync(extensions, context = {}) {
	const contributions = [];
	walkAppExtensionSync(extensions, contributions, collectVisitor, { onFunction: "Cannot resolve function app extensions synchronously" });
	return new FacetRuntime(context, contributions);
}
/** Validate a contribution against its facet's `validate` guard and, if
*  it passes, append it to `output`. Returns whether it was accepted —
*  the boundary-aware resolver uses the result to decide whether to
*  recurse into the contribution's `enables` subtree. */
var pushValidatedContribution = (contribution, output) => {
	const validate = contribution.facet.validate;
	if (validate && !validate(contribution.value)) {
		console.error(`Dropping invalid contribution for facet "${contribution.facet.id}"`, {
			source: contribution.source,
			value: contribution.value
		});
		return false;
	}
	output.push(contribution);
	return true;
};
/** Bare collector visitor: append every valid contribution and never
*  recurse into `enables`. This is the historical, togglable-blind
*  semantics of the facet.ts collectors — there's no `array` hook, so
*  togglable boundaries are walked like any other array. Callers that
*  need toggle boundaries go through `resolveAppRuntime` instead. */
var collectVisitor = { contribution: (node, output) => {
	pushValidatedContribution(node, output);
	return null;
} };
/** Runtime type guard for a FacetContribution leaf. Shared by every
*  AppExtension walk (collector, boundary-aware resolver, toggle
*  discovery, dynamic loader) so the grammar's leaf shape is recognised
*  in exactly one place. */
var isFacetContribution = (value) => typeof value === "object" && value !== null && value.type === "facet-contribution";
var isExtensionArray = (extension) => Array.isArray(extension);
/** Async walk over the AppExtension grammar — awaits function-valued
*  nodes (e.g. the dynamic-extensions loader) and logs + recovers if one
*  rejects, so a single bad subtree can't abort the whole resolution. */
async function walkAppExtension(node, ctx, visitor, options) {
	if (!node) return;
	if (typeof node === "function") {
		try {
			await walkAppExtension(await node(options.context), ctx, visitor, options);
		} catch (error) {
			console.error("Failed to resolve app extension", error);
		}
		return;
	}
	if (isExtensionArray(node)) {
		const childCtx = visitor.array ? visitor.array(node, ctx) : ctx;
		if (childCtx === null) return;
		for (const child of node) await walkAppExtension(child, childCtx, visitor, options);
		return;
	}
	if (isFacetContribution(node)) {
		const { seen } = options;
		if (seen) {
			if (seen.has(node)) return;
			seen.add(node);
		}
		const enablesCtx = visitor.contribution(node, ctx);
		if (enablesCtx !== null && node.enables) await walkAppExtension(node.enables, enablesCtx, visitor, options);
	}
}
/** Sync walk over the AppExtension grammar — throws on function-valued
*  nodes (the static extension tree has none, and first-paint resolution
*  can't await). */
function walkAppExtensionSync(node, ctx, visitor, options) {
	if (!node) return;
	if (typeof node === "function") throw new Error(options.onFunction);
	if (isExtensionArray(node)) {
		const childCtx = visitor.array ? visitor.array(node, ctx) : ctx;
		if (childCtx === null) return;
		for (const child of node) walkAppExtensionSync(child, childCtx, visitor, options);
		return;
	}
	if (isFacetContribution(node)) {
		const { seen } = options;
		if (seen) {
			if (seen.has(node)) return;
			seen.add(node);
		}
		const enablesCtx = visitor.contribution(node, ctx);
		if (enablesCtx !== null && node.enables) walkAppExtensionSync(node.enables, enablesCtx, visitor, options);
	}
}
//#endregion
export { FacetRuntime, combineLastContributionResult, dedupById, defineFacet, isFacetContribution, isFunction, keyedMapFacet, pushValidatedContribution, resolveFacetRuntimeSync, resolveLastContributionResult, walkAppExtension, walkAppExtensionSync };

//# sourceMappingURL=facet.js.map