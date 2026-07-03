import { definitionBlockProjectorFacet } from "./facets.js";
//#region src/data/projectorRuntime.ts
/** One running projector. Private to this module — `ProjectorRuntime`
*  owns instances; everything else reads through `ProjectorHandle`. */
var ProjectorLifecycle = class {
	contributions = [];
	/** key (schema name / type id) -> source block id. */
	byKey = /* @__PURE__ */ new Map();
	/** source block id -> resolved contribution. */
	byBlockId = /* @__PURE__ */ new Map();
	/** Latest rows captured by the subscription, in the hydrated form
	*  `project` consumes. Stored so the secondary signal re-resolves
	*  without a fresh DB read. */
	latestRows = [];
	subscriptionDisposer = null;
	secondaryDisposer = null;
	/** True once the workspace-pinned subscription has delivered its
	*  first tick. Gates the secondary-signal rebuild. */
	primed = false;
	/** False until dispose(); the in-flight-write guard (see module
	*  header). Starts false so the synchronous write path (`upsert`,
	*  used by schemas' `addSchema`) works even when the subscription was
	*  never started — e.g. the Roam importer registers schemas in batch
	*  without a live workspace subscription. `start()` re-arms it after a
	*  prior dispose so a reused container publishes again. */
	disposed = false;
	constructor(repo, descriptor, ctx) {
		this.repo = repo;
		this.descriptor = descriptor;
		this.ctx = ctx;
	}
	start() {
		if (this.subscriptionDisposer) throw new Error(`[projector ${this.descriptor.id}] already started`);
		const workspaceId = this.repo.activeWorkspaceId;
		if (!workspaceId) throw new Error(`[projector ${this.descriptor.id}] no active workspace at start()`);
		this.disposed = false;
		this.subscriptionDisposer = this.repo.subscribeBlocks({
			workspaceId,
			types: [this.descriptor.metaType]
		}, (rows) => this.rebuild(this.hydrate(rows)));
		const secondarySignal = this.descriptor.secondarySignal;
		if (secondarySignal) this.secondaryDisposer = secondarySignal(this.repo, () => {
			if (!this.primed || this.disposed) return;
			this.rebuild(this.latestRows);
		});
	}
	dispose() {
		this.disposed = true;
		this.subscriptionDisposer?.();
		this.subscriptionDisposer = null;
		this.secondaryDisposer?.();
		this.secondaryDisposer = null;
		this.latestRows = [];
		this.contributions = [];
		this.byKey = /* @__PURE__ */ new Map();
		this.byBlockId = /* @__PURE__ */ new Map();
		this.primed = false;
		this.repo.setRuntimeContributions(this.descriptor.targetFacet, this.descriptor.sourceId, []);
	}
	blockIdForKey(key) {
		return this.byKey.get(key);
	}
	contributionForBlockId(blockId) {
		return this.byBlockId.get(blockId);
	}
	upsert(contribution, blockId) {
		if (this.disposed) return;
		const key = this.descriptor.keyOf(contribution);
		this.contributions = [...this.contributions.filter((c) => this.descriptor.keyOf(c) !== key), contribution];
		this.byKey.set(key, blockId);
		this.byBlockId.set(blockId, contribution);
		this.publish();
	}
	hydrate(rows) {
		return this.descriptor.hydrate ? this.descriptor.hydrate(rows, this.ctx) : rows;
	}
	rebuild(rows) {
		if (this.disposed) return;
		this.latestRows = rows;
		this.primed = true;
		const next = [];
		const nextByKey = /* @__PURE__ */ new Map();
		const nextByBlockId = /* @__PURE__ */ new Map();
		for (const row of rows) {
			const built = this.descriptor.project(row, this.ctx);
			if (built) {
				next.push(built);
				nextByKey.set(this.descriptor.keyOf(built), row.id);
				nextByBlockId.set(row.id, built);
			}
		}
		if (this.descriptor.dedup?.(next, this.contributions)) return;
		this.contributions = next;
		this.byKey = nextByKey;
		this.byBlockId = nextByBlockId;
		this.publish();
	}
	publish() {
		if (this.disposed) return;
		this.repo.setRuntimeContributions(this.descriptor.targetFacet, this.descriptor.sourceId, this.contributions);
	}
};
/** Registry + driver for definition-block projectors. One instance per
*  Repo (`repo.projectors`).
*
*  Each projector's lifecycle container is created lazily and KEPT for
*  the life of the Repo — not torn down on `dispose`. Two reasons:
*    - the synchronous write path / read getters must work without a
*      live subscription (the importer registers schemas in batch; the
*      property panel reads `getSchemaForBlockId` before any start);
*    - keeping the disposed container (rather than deleting + lazily
*      re-creating a fresh one) is what makes the `disposed` in-flight
*      guard durable: a write completing after a workspace-switch
*      teardown re-reads the SAME disposed container and no-ops, instead
*      of resurrecting a fresh container that would republish.
*  `start()` re-arms a reused container; `dispose()` just deactivates +
*  resets it. */
var ProjectorRuntime = class {
	lifecycles = /* @__PURE__ */ new Map();
	ctx;
	constructor(repo) {
		this.repo = repo;
		this.ctx = {
			repo,
			handle: (id) => this.obtain(id)
		};
	}
	/** Read handle onto a projector's state — for the service facades and
	*  cross-projector `ctx` lookups. Lazily materialises the container
	*  from the facet descriptor; undefined only when no projector with
	*  that id is registered. */
	handle(projectorId) {
		return this.obtain(projectorId);
	}
	/** Start a projector by id, resolving its descriptor from
	*  `definitionBlockProjectorFacet`. The service facades' `start()`
	*  funnel through here so the descriptor stays data-defined. Throws on
	*  double-start (the `[...] already started` invariant). Returns a
	*  disposer. */
	startById(projectorId) {
		const lifecycle = this.obtain(projectorId);
		if (!lifecycle) throw new Error(`[ProjectorRuntime] no projector registered with id ${projectorId}`);
		lifecycle.start();
		return () => this.disposeProjector(projectorId);
	}
	/** Start every registered projector in dependency order — the
	*  production entry point. Adding a projector is then just registering
	*  a descriptor. Returns a disposer that tears them down in reverse. */
	startAll() {
		const ordered = orderByDependencies(this.descriptors());
		const disposers = [];
		const disposeStarted = () => {
			for (let i = disposers.length - 1; i >= 0; i--) disposers[i]();
		};
		for (const descriptor of ordered) try {
			disposers.push(this.startById(descriptor.id));
		} catch (err) {
			disposeStarted();
			throw err;
		}
		return disposeStarted;
	}
	/** Deactivate + reset a projector (idempotent). The container is kept
	*  for reuse / the in-flight guard (see class doc). */
	disposeProjector(projectorId) {
		this.lifecycles.get(projectorId)?.dispose();
	}
	/** Get-or-create the persistent container for `projectorId`, resolving
	*  its descriptor from the facet on first access.
	*
	*  Assumes the descriptor for a given id is STABLE for the life of the
	*  Repo: the container caches the descriptor it was first built with, so
	*  a later `setFacetRuntime` swap that re-registered the same id with a
	*  *different* descriptor would keep serving the original. That holds
	*  today — the two projectors are kernel consts registered once, never
	*  overridden — and `definitionBlockProjectorFacet` is not last-wins, so
	*  a duplicate id surfaces as a `startAll` double-start throw rather than
	*  a silent swap. Revisit this caching if projectors ever become
	*  per-id-overridable (e.g. plugin-replaceable descriptors). */
	obtain(projectorId) {
		const existing = this.lifecycles.get(projectorId);
		if (existing) return existing;
		const descriptor = this.descriptors().find((d) => d.id === projectorId);
		if (!descriptor) return void 0;
		const lifecycle = new ProjectorLifecycle(this.repo, descriptor, this.ctx);
		this.lifecycles.set(projectorId, lifecycle);
		return lifecycle;
	}
	descriptors() {
		const runtime = this.repo.facetRuntime;
		if (!runtime) throw new Error("[ProjectorRuntime] no FacetRuntime installed");
		return runtime.read(definitionBlockProjectorFacet);
	}
};
/** Stable topological order honoring `dependsOn`. Keeps registration
*  order among independent projectors; throws on a dependency cycle. */
function orderByDependencies(descriptors) {
	const byId = new Map(descriptors.map((d) => [d.id, d]));
	const ordered = [];
	const done = /* @__PURE__ */ new Set();
	const onStack = /* @__PURE__ */ new Set();
	const visit = (descriptor) => {
		if (done.has(descriptor.id)) return;
		if (onStack.has(descriptor.id)) throw new Error(`[ProjectorRuntime] dependency cycle at projector ${descriptor.id}`);
		onStack.add(descriptor.id);
		for (const depId of descriptor.dependsOn ?? []) {
			const dep = byId.get(depId);
			if (dep) visit(dep);
		}
		onStack.delete(descriptor.id);
		done.add(descriptor.id);
		ordered.push(descriptor);
	};
	for (const descriptor of descriptors) visit(descriptor);
	return ordered;
}
//#endregion
export { ProjectorRuntime };

//# sourceMappingURL=projectorRuntime.js.map