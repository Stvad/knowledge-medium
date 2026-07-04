import { FacetRuntime } from "../facets/facet.js";
import { appEffectsFacet } from "./core.js";
//#region src/extensions/liveRuntime.ts
/**
* Effect ↔ runtime-capture contract + effect lifecycle reconciliation
* (audit B1(4)).
*
* Problem: `AppRuntimeProvider` builds a fresh `FacetRuntime` on every
* swap (base → base+dynamic load, extension toggle). App effects capture
* the runtime they were started with — they `read` it, subscribe via
* `onFacetChange`, and write transient buckets via
* `setRuntimeContributions` (theme apply-actions, keybinding overrides),
* and the agent-runtime bridge captures it for command execution. So if
* we keep an unchanged effect running across a swap (the whole point of
* "restart only changed effects"), it strands on the dead runtime — the
* bug that reverted the #152 effect-diffing attempt.
*
* Fix: effects capture a stable `LiveRuntimeHandle` instead of a raw
* `FacetRuntime`. The handle is a `FacetRuntime` (so nothing downstream
* re-types) that delegates every read to a swappable `current`. On a
* swap, `setCurrent` migrates the kept effects' subscriptions and
* transient buckets onto the fresh runtime and re-fires subscribers so
* they re-sync — without restarting the effect. `EffectReconciler` then
* diffs `appEffectsFacet` by id and starts/stops only the delta.
*/
/** A `FacetRuntime` facade effects capture so they survive runtime swaps.
*  It owns no contribution state of its own — the inherited `super`
*  storage is never read because every public method is overridden:
*  reads/writes/subscriptions delegate to `current`, and
*  `adoptDurableContributionsFrom` throws (the handle is never a swap
*  target). It just forwards to whichever runtime is installed and
*  re-points the effect's subscriptions / transient buckets when that
*  runtime swaps. */
var LiveRuntimeHandle = class extends FacetRuntime {
	current;
	forwarded = /* @__PURE__ */ new Set();
	/** Transient (effect-owned) buckets written through this handle, keyed
	*  facetId → sourceId. Replayed onto the fresh runtime on `setCurrent`
	*  because the owning effect is NOT restarted across the swap, so it
	*  won't re-push them itself. Cleared when the effect writes `[]`
	*  (its cleanup) so a removed effect doesn't strand. */
	buckets = /* @__PURE__ */ new Map();
	constructor(initial) {
		super(initial.context, []);
		this.current = initial;
		Object.defineProperty(this, "context", {
			get: () => this.current.context,
			enumerable: true,
			configurable: true
		});
	}
	read(facet) {
		return this.current.read(facet);
	}
	contributions(facet) {
		return this.current.contributions(facet);
	}
	contributionsById(facetId) {
		return this.current.contributionsById(facetId);
	}
	facetIds() {
		return this.current.facetIds();
	}
	/** Unsupported on the handle: it is a stable wrapper effects hold, never
	*  a runtime a swap installs, so it is never the *target* of a durable
	*  adoption. Overridden to fail loud rather than silently write into the
	*  dead inherited `super` storage that the delegating reads never
	*  consult (which would lose the durable data with no error). */
	adoptDurableContributionsFrom() {
		throw new Error("[LiveRuntimeHandle] adoptDurableContributionsFrom is not supported — the handle is a stable wrapper, never a swap target");
	}
	onFacetChange(facetId, listener) {
		const reg = {
			facetId,
			listener,
			unsub: this.current.onFacetChange(facetId, listener)
		};
		this.forwarded.add(reg);
		return () => {
			reg.unsub();
			this.forwarded.delete(reg);
		};
	}
	setRuntimeContributions(facet, sourceId, contributions, options) {
		if (contributions.length === 0) {
			const bySource = this.buckets.get(facet.id);
			bySource?.delete(sourceId);
			if (bySource && bySource.size === 0) this.buckets.delete(facet.id);
		} else {
			const bySource = this.buckets.get(facet.id) ?? /* @__PURE__ */ new Map();
			bySource.set(sourceId, {
				facet,
				contributions,
				durable: options?.durable
			});
			this.buckets.set(facet.id, bySource);
		}
		this.current.setRuntimeContributions(facet, sourceId, contributions, options);
	}
	/** Point the handle at a freshly-installed runtime. Migrates the kept
	*  effects' subscriptions and transient buckets, then re-fires the
	*  subscribers so they re-read the new merged view (e.g. the theme
	*  effect rebuilds its stylesheet + apply-actions for the new theme
	*  set). No-op if `next` is already current. */
	setCurrent(next) {
		if (next === this.current) return;
		this.current = next;
		for (const bySource of this.buckets.values()) for (const [sourceId, bucket] of bySource) next.setRuntimeContributions(bucket.facet, sourceId, bucket.contributions, { durable: bucket.durable });
		for (const reg of this.forwarded) {
			reg.unsub();
			reg.unsub = next.onFacetChange(reg.facetId, reg.listener);
		}
		for (const reg of this.forwarded) try {
			reg.listener();
		} catch (error) {
			console.error(`[LiveRuntimeHandle] forwarded listener for ${reg.facetId} threw`, error);
		}
	}
};
var runCleanup = (cleanup, effectId) => {
	try {
		const result = cleanup();
		if (result instanceof Promise) result.catch((error) => {
			console.error(`App effect cleanup failed for ${effectId}`, error);
		});
	} catch (error) {
		console.error(`App effect cleanup failed for ${effectId}`, error);
	}
};
var startEffect = (effect, context) => {
	const entry = {
		id: effect.id,
		effect,
		stopped: false
	};
	try {
		const result = effect.start(context);
		if (typeof result === "function") entry.cleanup = result;
		else if (result instanceof Promise) result.then((cleanup) => {
			if (typeof cleanup !== "function") return;
			if (entry.stopped) {
				runCleanup(cleanup, effect.id);
				return;
			}
			entry.cleanup = cleanup;
		}).catch((error) => {
			console.error(`App effect failed to start for ${effect.id}`, error);
		});
	} catch (error) {
		console.error(`App effect failed to start for ${effect.id}`, error);
	}
	return entry;
};
var stopEffect = (entry) => {
	entry.stopped = true;
	if (entry.cleanup) {
		runCleanup(entry.cleanup, entry.id);
		entry.cleanup = void 0;
	}
};
/** Drives the app-effect lifecycle across runtime swaps (B1(4)).
*
*  - When `repo` / `workspaceId` / `safeMode` change (values effects
*    capture directly, not through the runtime), every effect restarts —
*    keeping one alive would strand it on stale context.
*  - When only the runtime changes (the common toggle / dynamic-load
*    path), effects are diffed by id: newly-added ones start, removed
*    ones stop, and unchanged ones keep running on the `LiveRuntimeHandle`
*    (which `setCurrent` re-points at the fresh runtime). */
var EffectReconciler = class {
	liveRuntime = null;
	started = /* @__PURE__ */ new Map();
	capturedCtx = null;
	/** Whether `{repo, workspaceId, safeMode}` differs from the context the
	*  reconciler last captured — i.e. the next `reconcile` would be a full
	*  restart (cold) rather than a runtime-only diff (warm). This is the
	*  single source of truth for "cold vs warm": `AppRuntimeProvider`
	*  queries it to decide whether to commit the sync base runtime (cold
	*  start) or hold the current one for a same-context reload, instead of
	*  tracking the same latch separately. A never-reconciled or
	*  just-disposed reconciler is cold. */
	isColdFor(repo, workspaceId, safeMode) {
		return this.capturedCtx === null || this.capturedCtx.repo !== repo || this.capturedCtx.workspaceId !== workspaceId || this.capturedCtx.safeMode !== safeMode;
	}
	reconcile(repo, runtime, workspaceId, safeMode) {
		const ctxChanged = this.isColdFor(repo, workspaceId, safeMode);
		const effects = runtime.read(appEffectsFacet);
		const nextById = /* @__PURE__ */ new Map();
		for (const effect of effects) {
			if (nextById.has(effect.id)) console.warn(`[appEffectsFacet] duplicate effect id "${effect.id}"; last-wins per facet convention`);
			nextById.set(effect.id, effect);
		}
		if (ctxChanged) {
			this.stopAll();
			this.liveRuntime = new LiveRuntimeHandle(runtime);
			this.capturedCtx = {
				repo,
				workspaceId,
				safeMode
			};
		} else {
			for (const [id, entry] of this.started) {
				const next = nextById.get(id);
				if (next === void 0 || next !== entry.effect) {
					stopEffect(entry);
					this.started.delete(id);
				}
			}
			this.liveRuntime.setCurrent(runtime);
		}
		const live = this.liveRuntime;
		for (const effect of nextById.values()) {
			if (this.started.has(effect.id)) continue;
			this.started.set(effect.id, startEffect(effect, {
				repo,
				runtime: live,
				workspaceId,
				safeMode
			}));
		}
	}
	/** Stop every running effect (provider unmount). */
	dispose() {
		this.stopAll();
		this.capturedCtx = null;
		this.liveRuntime = null;
	}
	stopAll() {
		for (const entry of [...this.started.values()].reverse()) stopEffect(entry);
		this.started.clear();
	}
};
//#endregion
export { EffectReconciler, LiveRuntimeHandle };

//# sourceMappingURL=liveRuntime.js.map