import { ChangeScope } from "./api/changeScope.js";
import { MutatorNotRegisteredError, ParentDeletedError, QueryNotRegisteredError } from "./api/errors.js";
import { derivedRefKey, reconcileDerived } from "./api/derivedData.js";
import { ProcessorRejection } from "./api/sameTxProcessor.js";
import "./api/index.js";
import { KERNEL_PROPERTY_SCHEMAS } from "./properties.js";
import v4 from "../../node_modules/uuid/dist/v4.js";
import { resolveFacetRuntimeSync } from "../facets/facet.js";
import { latestRefProjectionSchema, projectedRefsForField, refCodecKind } from "./internals/refProjection.js";
import { buildQualifiedBlockColumnsSql, parseBlockRow } from "./blockSchema.js";
import { ANCESTORS_SQL, CHILDREN_SQL, SUBTREE_SQL } from "./internals/treeQueries.js";
import { jsonPathForProperty, normalizeTypedBlockQuery } from "./internals/typedBlockQuery.js";
import { SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL, SELECT_BLOCK_BY_ID_SQL } from "./internals/kernelQueries.js";
import { runTx } from "./internals/commitPipeline.js";
import { devAssertionsEnabled } from "./internals/devAssertions.js";
import { systemPagesFacet } from "./facets.js";
import { KERNEL_TYPE_CONTRIBUTIONS } from "./blockTypes.js";
import { propertiesPageBlockId } from "./propertiesPage.js";
import { typesPageBlockId } from "./typesPage.js";
import { UserSchemasService } from "./userSchemasService.js";
import { UserTypesService } from "./userTypesService.js";
import { kernelDataExtension } from "./kernelDataExtension.js";
import { ProcessorRunner } from "./internals/processorRunner.js";
import { Block } from "./block.js";
import { HandleStore, LoaderHandle, handleKey, snapshotsToChangeNotification } from "./internals/handleStore.js";
import { DbMetrics, QueryMetrics, wrapDbWithMetrics } from "./internals/timingMetrics.js";
import { startBlocksSyncedObserver } from "./internals/syncObserver/observer.js";
import { parseAliasCollisionError, parseParentDeletedError } from "./internals/raiseProtocol.js";
import { CLEAR_REPROJECT_REF_MARKER_SQL, RECONCILE_RESCAN_MARKER_PREFIX, RECORD_RECONCILE_RESCAN_MARKER_SQL, RECORD_REPROJECT_REF_MARKER_SQL, RECORD_WORKSPACE_BACKFILL_MARKER_SQL, REPROJECT_REF_MARKER_PREFIX, SELECT_RECONCILE_RESCAN_MARKER_SQL, SELECT_REPROJECT_REF_MARKERS_SQL, SELECT_WORKSPACE_BACKFILL_MARKERS_SQL, WORKSPACE_BACKFILL_MARKER_PREFIX } from "./internals/clientSchema.js";
import { CATCHUP_DEEP_IDLE, scheduleDeepIdle } from "../utils/scheduleIdle.js";
import { MarkerStore, PendingIdleJobs } from "./internals/idleMarkerJobs.js";
import { CallbackSet } from "../utils/callbackSet.js";
import { UndoManager } from "./internals/undoManager.js";
import { ProjectorRuntime } from "./projectorRuntime.js";
import { TypeTagger } from "./typeTagger.js";
import { FacetBridge } from "./facetBridge.js";
//#region src/data/repo.ts
/**
* New `Repo` class for the data-layer redesign (spec §3, §8).
*
* Stage 1.4 scope: holds `db` + `cache` + `user` + the mutator registry
* (kernel mutators registered at construction time). Exposes:
*   - `repo.tx(fn, opts)` — primitive transactional session
*   - `repo.mutate.X(args)` — typed-dispatch sugar (1-mutator tx wrapping)
*   - `repo.run(name, args)` — runtime-validated dispatch (dynamic plugins)
*   - `repo.setFacetRuntime(runtime)` — refresh mutator registry from a
*     FacetRuntime. Minimal impl reads `mutatorsFacet` contributions.
*
* Stage 2 of Phase 1 (post-1.6) adds:
*   - HandleStore + `repo.block(id)` / `repo.children(id)` / etc.
*   - Layout B sync observer for sync-applied invalidation (design doc §9.2)
*/
var KERNEL_TYPES = new Map(KERNEL_TYPE_CONTRIBUTIONS.map((t) => [t.id, t]));
var KERNEL_PROPERTY_SCHEMA_MAP = new Map(KERNEL_PROPERTY_SCHEMAS.map((s) => [s.name, s]));
/** Bounded ring of recent tx entries surfaced via `repo.metrics().txLog`.
*  Sized to comfortably cover a cold-start window (a few dozen txs) so
*  diagnostic dumps right after page load don't lose entries. */
var TX_LOG_CAPACITY = 64;
/** Registry key for the per-workspace undo manager when no workspace is
*  active (issue #186). Workspace ids are UUIDs, so this sentinel can
*  never collide with a real one. The manager under this key stays empty
*  in practice — `repo.tx` only records under a pinned (non-null)
*  workspace and `undo()`/`redo()` no-op when there's no active workspace. */
var NO_ACTIVE_WORKSPACE = "__no_active_workspace__";
/** Max `ctx.run` composition depth before we assume a cycle (a query
*  composing itself, directly or transitively). Composition chains are
*  shallow in practice; this just turns a stack overflow into a clear
*  diagnostic. */
var MAX_QUERY_COMPOSITION_DEPTH = 32;
/** Suffix (the part after the `reproject_ref:` prefix) of a per-workspace
*  reprojection marker. Reprojection is workspace-scoped, so each workspace
*  records its own "already backfilled name X" marker. Workspace ids are UUIDs
*  (no colons), so this stays unambiguous even though property names can carry
*  colons (e.g. `roam:isa`). */
var reprojectionMarkerKey = (workspaceId, name) => `${workspaceId}:${name}`;
/** Suffix (after the `workspace_backfill:` prefix) of a per-workspace
*  workspace-backfill completion marker — `<workspaceId>:<backfillId>`. Same
*  shape/rationale as `reprojectionMarkerKey`. */
var workspaceBackfillMarkerKey = (workspaceId, id) => `${workspaceId}:${id}`;
var Repo = class Repo {
	db;
	cache;
	user;
	/** Read-only mode disables `BlockDefault` / `References` writes;
	*  UI-state and UserPrefs writes still pass through and queue to
	*  ps_crud — server-side rejection (RLS) lands in the rejection
	*  quarantine. Mutate via `repo.setReadOnly(value)` rather than
	*  direct field assignment so callers from inside React hooks don't
	*  trip `react-hooks/immutability` lint (the mutation should travel
	*  through a method, not a property write). */
	isReadOnly;
	now;
	newId;
	newTxSeq;
	mutators = /* @__PURE__ */ new Map();
	processors = /* @__PURE__ */ new Map();
	/** Same-tx processor registry — runs inside the user's
	*  writeTransaction in `runTx`. Kept separate from
	*  `this.processors` (post-commit) because the two have different
	*  ctx shapes and run at different pipeline stages; see
	*  `sameTxProcessorsFacet` doc in `facets.ts`. */
	sameTxProcessors = /* @__PURE__ */ new Map();
	queries = /* @__PURE__ */ new Map();
	_types = KERNEL_TYPES;
	_propertySchemas = KERNEL_PROPERTY_SCHEMA_MAP;
	_propertyEditorOverrides = /* @__PURE__ */ new Map();
	_valuePresets = /* @__PURE__ */ new Map();
	invalidationRules = [];
	/** Facet→registry bridge (audit D1(c)) — owns the installed
	*  FacetRuntime, the rebuild steps, the per-facet change subscriptions,
	*  and the React-facing schema/type/override/preset change channels.
	*  Constructed in the constructor (the rebuild steps write back into
	*  this Repo's registries through a callback target). */
	facetBridge;
	/** Listeners for user-surfaceable errors thrown from inside a
	*  `repo.tx` — currently `ProcessorRejection` from same-tx
	*  processors. Subscribers are responsible for the UI side
	*  (toast routing); the data layer stays UI-agnostic. */
	userErrorListeners = new CallbackSet("Repo.userErrors");
	/** Global query-registry epoch. Bumped by `swapQueries` (via
	*  `setFacetRuntime` / `__setQueriesForTesting`) when an existing query is
	*  REPLACED or REMOVED — NOT for a purely-additive swap (see
	*  `swapQueries`). The epoch is folded into EVERY query handle-store key,
	*  so a bump re-keys all queries at once:
	*
	*   - A handle, once obtained, is immutable: it stays at its epoch's key,
	*     keeps its captured registry snapshot, and keeps serving that
	*     version (a data-driven re-resolve re-runs against the SAME snapshot
	*     — see `dispatchQuery` / `runSubquery`, which pin the outer resolver
	*     and every `ctx.run` helper to the registry captured at creation).
	*   - Re-obtaining a handle (the next `repo.query` lookup, e.g. a remount
	*     or re-render) computes the new-epoch key → a fresh handle over the
	*     current registry → the new version.
	*
	*  Why one epoch instead of a per-name / composition-graph scheme on a
	*  replace/remove: a composed query's set of helpers is only known by
	*  RUNNING it, so any surgical "re-key just the affected queries" approach
	*  silently misses unobserved compositions — idle handles, first-load
	*  races, and data-conditional branches — and hands a fresh lookup
	*  pre-swap code. Re-keying everything is correct by construction.
	*
	*  Cost: a swap never re-resolves a LIVE handle in place; the cost of a
	*  bump is that the next render re-looks-up → fresh handle + cold resolve
	*  for every query, even unaffected ones. To keep that off the hot path we
	*  do NOT bump on additive swaps — and for an all-plugins-enabled user the
	*  cold-start `base→next` swap IS additive (adds dynamic-plugin queries
	*  while kernel/static instances stay identical), so the visible tree's
	*  already-loaded kernel queries (subtree/children/...) keep their handles.
	*  The over-resolve happens on a genuine replace/remove (plugin
	*  reload/disable) — rare and defensible — AND, today, once at cold start
	*  for users who've DISABLED a data-extension plugin (the bootstrap→base
	*  REMOVE; see the init-layer limitation note on `swapQueries`). */
	queryEpoch = 0;
	processorRunner;
	/** Type-tagging engine (audit D1(b)) — backs the `addType` /
	*  `removeType` / `toggleType` / `setBlockTypes` delegating methods. */
	typeTagger;
	/** Per-WORKSPACE undo / redo state (spec §10 step 7, §17 line 2228;
	*  issue #186). Each workspace gets its own `UndoManager` (independent
	*  per-scope stacks), so cmd-Z only ever acts on the workspace the user
	*  is looking at and a switch can never revert an edit in a workspace
	*  they've left — while switching back restores that workspace's
	*  history. The public `undoManager` getter resolves to the active
	*  workspace's manager; `repo.tx` records into the tx's pinned
	*  workspace; `repo.undo` / `repo.redo` pop + replay via
	*  `TxImpl.applyRaw`. */
	undoManagers = /* @__PURE__ */ new Map();
	/** Identity-stable Block facades, keyed by id. Block satisfies
	*  Handle<BlockData|null> structurally (spec §5.1, §5.2) — its
	*  row-grain reactivity goes through BlockCache.subscribe directly,
	*  so it doesn't need a HandleStore entry; this map IS its identity
	*  table. */
	blockFacades = /* @__PURE__ */ new Map();
	/** Handle registry for query-backed collection factories: `children`,
	*  `subtree`, `ancestors`, plugin queries, etc. Identity rule:
	*  same key → same LoaderHandle instance. GC after `gcTimeMs` of
	*  zero subscribers + zero in-flight loads. The store also walks
	*  invalidation: TxEngine fast path + the Layout B sync observer
	*  call `handleStore.invalidate({…})` to fan out to dep-matching
	*  handles. */
	handleStore = new HandleStore();
	/** Per-PowerSyncDb-call timings (getAll / getOptional / get /
	*  execute / writeTransaction). Populated by the metrics-wrapping
	*  proxy installed around `this.db` at construction. */
	dbMetrics = new DbMetrics();
	/** Per-query-name resolve timings. The dispatcher records each
	*  `loader(ctx)` invocation here keyed by the query's full name. */
	queryMetrics = new QueryMetrics();
	/** Counters for `reprojectRefTypedProperties`. Each call to the
	*  reprojection path increments these — useful when investigating
	*  bootstrap-time write-tx amplification triggered by user/plugin
	*  schema changes. Surfaced through `repo.metrics().reprojection`. */
	reprojectionMetrics = {
		calls: 0,
		schemasReprojected: 0,
		rowsScanned: 0,
		blocksUpdated: 0,
		msTotal: 0,
		skippedByMarker: 0,
		skippedByAbsence: 0
	};
	/** Lazy in-memory mirror of the per-name reprojection markers in
	*  `client_schema_state` (rows keyed `reproject_ref:<workspaceId>:<name>`).
	*  Loaded on first reprojection call via a single
	*  `SELECT key … LIKE 'reproject_ref:%'` round-trip; afterwards
	*  `reprojectRefTypedProperties` skips ref-typed names already marked
	*  without further SQL. Constructed in the constructor (needs `this.db`).
	*  Tests / migrations that wipe the table call
	*  `__resetReprojectionMarkerCache` to force a reload. */
	reprojectionMarkers;
	/** In-flight reprojection runs whose deferral timer has already fired.
	*  `scheduleReprojection` is fire-and-forget (the cold-start path must
	*  not block on it); `awaitReprojections()` drains this for
	*  deterministic test quiescence and to keep a stray reprojection from
	*  writing into the next test on a shared DB.
	*
	*  These three maintenance passes are one-time-per-workspace data-completeness
	*  catch-ups (derived backlinks, daily-note:date etc., shadow-bug recovery),
	*  so they run on deep idle off the cold-start window — but WITH a fallback so
	*  a never-idle session still completes them this session (CATCHUP_DEEP_IDLE),
	*  unlike the lazy data-integrity audit which may skip a session. */
	reprojectionJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE));
	/** Registered workspace backfills (`workspaceBackfillsFacet` snapshot,
	*  refreshed by the `workspaceBackfills` rebuild step). Run once per
	*  workspace by `scheduleWorkspaceBackfills`. */
	_workspaceBackfills = [];
	/** Lazy in-memory mirror of the workspace-backfill completion markers in
	*  `client_schema_state` (rows keyed `workspace_backfill:<ws>:<id>`), same
	*  pattern as `reprojectionMarkers`. Constructed in the constructor. */
	workspaceBackfillMarkers;
	/** In-flight workspace-backfill runs whose deferral timer has fired —
	*  drained by `awaitWorkspaceBackfills()` for deterministic test quiescence,
	*  mirroring `reprojectionJobs`. */
	workspaceBackfillJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE));
	/** In-flight one-time reconcile-rescan runs — drained by
	*  `awaitReconcileRescans()`, same pattern. */
	reconcileRescanJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE));
	/** Slowest writeTransaction observed since the last reset, by
	*  description (`opts.description` passed to `repo.tx`). Updated only
	*  when a tx exceeds the previous high-water mark, so the field is
	*  cheap to maintain in the hot path. Surfaces through
	*  `repo.metrics().db.slowestTx`. */
	slowestTx = {
		description: null,
		ms: 0
	};
	/** Bounded log of recent tx (description, ms) — used to attribute
	*  cold-start `writeTransaction` totals to specific call sites. The
	*  most recent `TX_LOG_CAPACITY` entries are retained; older drops
	*  are silent. Surfaces through `repo.metrics().txLog`. */
	txLog = [];
	/** Active Layout B sync observer (design doc §9.2): drains the
	*  `blocks_synced` staging table into the app-visible `blocks` table and
	*  invalidates cache + handles. Replaces the row_events tail. Lazy:
	*  created on first start, replaced on subsequent starts. Tests can
	*  `dispose()` and re-`start` for deterministic flushing. */
	syncObserver = null;
	/** §6 mode/key resolver for the observer (undefined ⇒ plaintext stub). Public
	*  so the data-integrity plugin's audit runner can reuse the same resolver for
	*  the divergence decrypt-compare (undefined in tests ⇒ cleartext-only). */
	syncObserverDeps;
	/** Backing field for `activeWorkspaceId` (see getter/setter below). */
	_activeWorkspaceId = null;
	/** Instance discriminator for memoization keys that need to vary
	*  across Repo instances (e.g. lodash.memoize calls in the panel /
	*  user-page bootstrap). Auto-incremented per construction. */
	static nextInstanceId = 1;
	instanceId = Repo.nextInstanceId++;
	/** Hydrate a list of `BlockRow`s into the cache + return parsed
	*  BlockData[]. Internal helper for kernel queries. Callers choose
	*  whether returned rows are part of the query result (`row` deps) or
	*  only cache priming (`no row` deps). Accepts readonly so it pairs
	*  cleanly with the QueryCtx plumbing in `dispatchQuery`. */
	hydrateRows(rows, opts = {}) {
		const { ctx, declareRowDeps = Boolean(ctx) } = opts;
		const out = [];
		for (const r of rows) {
			const data = parseBlockRow(r);
			this.cache.applyIfNewer(data, "hydrate");
			if (ctx && declareRowDeps) ctx.depend({
				kind: "row",
				id: data.id
			});
			out.push(data);
		}
		return out;
	}
	get types() {
		return this._types;
	}
	get propertySchemas() {
		return this._propertySchemas;
	}
	get propertyEditorOverrides() {
		return this._propertyEditorOverrides;
	}
	get valuePresets() {
		return this._valuePresets;
	}
	/** Deterministic id of the workspace's Properties page (parent of
	*  all `'property-schema'` blocks). Created lazily by
	*  `getOrCreatePropertiesPage` during workspace bootstrap. */
	get propertiesPageId() {
		if (!this._activeWorkspaceId) return null;
		return propertiesPageBlockId(this._activeWorkspaceId);
	}
	/** Registry + driver for definition-block projectors (the
	*  data-defined "watch a meta-type → mirror into a facet bucket"
	*  pattern, issue #90). Owns the shared lifecycle for every projector
	*  registered in `definitionBlockProjectorFacet`; the React provider
	*  starts them all once per workspace via `startAll()`. The
	*  `userSchemas` / `userTypes` facades read their state through it. */
	projectors = new ProjectorRuntime(this);
	/** UserSchemasService singleton bound to this Repo. Owns the
	*  user-data contribution bucket on `propertySchemasFacet`; sharing
	*  one instance means imperative call sites (the AddPropertyForm,
	*  the Roam importer) all hit the same in-memory list rather than
	*  each fresh instance clobbering the bucket from an empty start.
	*  The block-subscription path is opt-in via `start()` (delegates to
	*  the `'user-schemas'` projector). */
	userSchemas = new UserSchemasService(this);
	/** UserTypesService singleton bound to this Repo. Symmetric to
	*  `userSchemas`: owns the user-data contribution bucket on
	*  `typesFacet`. The `'user-types'` projector depends on
	*  `'user-schemas'` (started first) to resolve block-type:properties
	*  refList entries to live property schemas. */
	userTypes = new UserTypesService(this);
	/** Deterministic id of the workspace's Types page (parent of every
	*  `'block-type'` block in the workspace). Created lazily by
	*  `getOrCreateTypesPage` during workspace bootstrap. */
	get typesPageId() {
		if (!this._activeWorkspaceId) return null;
		return typesPageBlockId(this._activeWorkspaceId);
	}
	/** Run `CHILDREN_SQL` for `parentId` and hydrate every row into the
	*  per-row cache. Shared by the `repo.load(id, {children: true})`
	*  opts path, `repo.children(id)` handle, and the hydrating variant
	*  of `repo.childIds(id)`. Collection-level reactivity is owned by
	*  the `LoaderHandle` returned from `repo.children` / `repo.childIds`
	*  — `BlockCache` doesn't track per-parent "loaded" state. */
	async hydrateChildren(parentId, ctx) {
		const rows = await this.db.getAll(CHILDREN_SQL, [parentId]);
		return this.hydrateRows(rows, { ctx });
	}
	/** Typed-dispatch sugar. `repo.mutate.indent({id})` opens a 1-mutator
	*  tx with the mutator's scope and runs it. Lookup tries the literal
	*  key first (`'tasks:setDueDate'` for plugin mutators), then
	*  `'core.${name}'` (so the bare `repo.mutate.indent` resolves to
	*  `'core.indent'`).
	*
	*  Typing surface (Phase 3 — chunk C): keys present in
	*  `MutatorRegistry` (kernel + augmented plugins, see §12.1) get
	*  precise `(args: Args) => Promise<Result>` types; the
	*  `core.<name>`-stripped form is also typed. Unknown keys
	*  (dynamically-loaded plugins that haven't augmented the registry)
	*  fall back to a permissive `(args: any) => Promise<any>` index
	*  signature so string-key access stays callable. */
	mutate;
	/** Typed query dispatch. `repo.query.subtree({id})` returns an
	*  identity-stable `LoaderHandle<R>` (the same instance for the same
	*  args, GC'd via HandleStore). Lookup tries the literal `name` first
	*  (`'core.subtree'` or `'plugin:foo'`), then `'core.${name}'` so the
	*  bare `repo.query.subtree` resolves to `'core.subtree'`. Args are
	*  validated against `Query.argsSchema` on every call.
	*
	*  Typing surface mirrors `repo.mutate`: keys present in
	*  `QueryRegistry` (kernel + augmented plugins) get precise
	*  `(args: Args) => LoaderHandle<Result>` types; the
	*  `core.<name>`-stripped form is also typed. Unknown keys
	*  (dynamically-loaded plugins that haven't augmented the registry)
	*  fall back to a permissive `(args: any) => LoaderHandle<any>` index
	*  signature so string-key access stays callable. The runtime
	*  `argsSchema` validation in `dispatchQuery` is the safety boundary
	*  for those paths. */
	query;
	constructor(opts) {
		this.db = wrapDbWithMetrics(opts.db, this.dbMetrics);
		this.reprojectionMarkers = new MarkerStore(this.db, REPROJECT_REF_MARKER_PREFIX, SELECT_REPROJECT_REF_MARKERS_SQL, RECORD_REPROJECT_REF_MARKER_SQL, CLEAR_REPROJECT_REF_MARKER_SQL);
		this.workspaceBackfillMarkers = new MarkerStore(this.db, WORKSPACE_BACKFILL_MARKER_PREFIX, SELECT_WORKSPACE_BACKFILL_MARKERS_SQL, RECORD_WORKSPACE_BACKFILL_MARKER_SQL);
		this.syncObserverDeps = opts.syncObserverDeps;
		this.cache = opts.cache;
		this.user = opts.user;
		this.isReadOnly = opts.isReadOnly ?? false;
		this.now = opts.now ?? Date.now;
		this.newId = opts.newId ?? v4;
		if (opts.newTxSeq) this.newTxSeq = opts.newTxSeq;
		else {
			let seq = Date.now();
			this.newTxSeq = () => ++seq;
		}
		this.processorRunner = new ProcessorRunner(this, this.db);
		this.typeTagger = new TypeTagger(this);
		this.facetBridge = new FacetBridge({
			getPropertySchemas: () => this._propertySchemas,
			applyMutators: (mutators) => {
				this.mutators = mutators;
			},
			applyProcessors: (processors) => {
				this.processors = processors;
			},
			applySameTxProcessors: (processors) => {
				this.sameTxProcessors = processors;
			},
			applyInvalidationRules: (rules) => {
				this.invalidationRules = rules;
			},
			applyWorkspaceBackfills: (backfills) => {
				this._workspaceBackfills = backfills;
			},
			applyTypesAndSchemas: (types, propertySchemas) => {
				this._types = types;
				this._propertySchemas = propertySchemas;
			},
			applyPropertyEditorOverrides: (overrides) => {
				this._propertyEditorOverrides = overrides;
			},
			applyValuePresets: (presets) => {
				this._valuePresets = presets;
			},
			applyQueries: (queries) => {
				this.swapQueries(queries);
			},
			scheduleReprojection: (names, schemas) => {
				this.scheduleReprojection(names, schemas);
			}
		});
		const dispatch = this.dispatchMutator.bind(this);
		this.mutate = new Proxy({}, { get: (_target, prop) => {
			if (typeof prop !== "string") return void 0;
			return dispatch(prop);
		} });
		const dispatchQ = this.dispatchQuery.bind(this);
		this.query = new Proxy({}, { get: (_target, prop) => {
			if (typeof prop !== "string") return void 0;
			return dispatchQ(prop);
		} });
		if (opts.installKernelRuntime ?? true) this.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]));
		if (opts.startSyncObserver ?? true) this.startSyncObserver(opts.syncObserverOptions);
	}
	/** Start the Layout B sync observer (design doc §9.2). Idempotent in
	*  spirit: if one is already running, it's disposed first so the new
	*  options take effect. Returns the observer for inspection / manual
	*  flushing. */
	startSyncObserver(options) {
		if (this.syncObserver) this.syncObserver.dispose();
		this.syncObserver = startBlocksSyncedObserver({
			db: this.db,
			cache: this.cache,
			handleStore: this.handleStore,
			deps: this.syncObserverDeps ?? {
				getMaterializability: () => "copy",
				getCek: async () => null
			},
			getInvalidationRules: () => this.invalidationRules,
			onCycleDetected: options?.onCycleDetected,
			throttleMs: options?.throttleMs,
			onError: options?.onError
		});
		return this.syncObserver;
	}
	/** Dispose the active sync observer (no-op if none). Tests use this to
	*  detach the subscription before tearing down the test DB. */
	stopSyncObserver() {
		if (this.syncObserver) {
			this.syncObserver.dispose();
			this.syncObserver = null;
		}
	}
	/** Manually flush the sync observer — drains any pending `blocks_synced`
	*  changes into `blocks` and walks `handleStore.invalidate(...)`. Tests
	*  use this instead of waiting on the throttle window; it's a real settle
	*  barrier (awaits every drain enqueued before it). */
	async flushSyncObserver() {
		if (this.syncObserver) await this.syncObserver.flush();
	}
	/** Re-materialize a workspace's staged `blocks_synced` rows after it becomes
	*  materializable (WK pasted / plaintext confirmed via the §8.2 gate). No-op
	*  if the observer isn't running. */
	async drainSyncWorkspace(workspaceId) {
		if (this.syncObserver) await this.syncObserver.drainWorkspace(workspaceId);
	}
	/** Frozen snapshot of internal data-layer counters + timings
	*  (perf-baseline follow-up #4). Returns four subsections:
	*
	*    - `handleStore` — invalidate fan-out (`invalidations`,
	*      `handlesWalked`, `handlesMatched`) and per-LoaderHandle
	*      lifecycle (`loaderInvalidations`, `loaderRuns`,
	*      `midLoadInvalidations`, `reloadsAfterSettle`,
	*      `notifiesFired`, `notifiesSkippedByDiff`).
	*    - `blockCache` — write/notify activity
	*      (`setSnapshotCalls`, `setSnapshotDedupHits/Misses`,
	*      `applyIfNewerSyncCalls`/`Rejected` for row_events-tail
	*      arrivals, `applyIfNewerHydrateCalls`/`Rejected` for
	*      kernel-query `hydrateRows` + `repo.load` re-reads,
	*      `notifies`).
	*    - `queries` — per-query-name resolve timings keyed by full
	*      name (e.g. `core.subtree`, `plugin:tasks/dueSoon`). Each
	*      entry is a `TimingSnapshot` with `calls`, mean, p50/p95/p99,
	*      min/max, and totalMs. Empty until a query runs.
	*    - `db` — aggregate PowerSyncDb call timings split by method
	*      (`getAll`, `getOptional`, `get`, `execute`, `writeTransaction`).
	*      `writeTransaction` records full wall-clock for the tx; the
	*      tx-internal SQL calls also count against their respective
	*      buckets — so a single `mutate.X` typically registers one
	*      `writeTransaction` sample plus several inner-SQL samples.
	*
	*  Plain counters are monotonic from the last `resetMetrics()` (or
	*  Repo construction). Timing reservoirs hold the last 256 samples
	*  for percentile estimation; their `calls` field is unbounded.
	*
	*  Each call returns a fresh frozen object so callers can keep two
	*  snapshots and diff them.
	*
	*  Useful as:
	*    - regression detection in production (`handlesWalked /
	*      invalidations` should drop once the inverted-index lands;
	*      `queries['backlinks.forBlock'].p95Ms` should drop once the
	*      backlinks index lands),
	*    - cold-start investigation (open a page, `repo.metrics()`,
	*      see which queries dominated and how many SQL roundtrips
	*      they incurred),
	*    - in-app debug panels that surface latency distributions
	*      without needing a Playwright + profiler harness. */
	metrics() {
		return Object.freeze({
			handleStore: this.handleStore.metrics.snapshot(),
			handleStoreInventory: this.handleStore.snapshotInventory(),
			blockCache: this.cache.metrics.snapshot(),
			queries: this.queryMetrics.snapshot(),
			db: this.dbMetrics.snapshot(),
			slowestTx: Object.freeze({ ...this.slowestTx }),
			txLog: Object.freeze(this.txLog.map((entry) => Object.freeze({ ...entry }))),
			reprojection: Object.freeze({ ...this.reprojectionMetrics })
		});
	}
	/** Zero every counter and reservoir in `repo.metrics()`. Use to
	*  mark a baseline before measuring a discrete operation (e.g. a
	*  benchmark iteration, a UI interaction in a soak test, or a
	*  cold-start "open page → metrics" investigation). */
	resetMetrics() {
		this.handleStore.metrics.reset();
		this.cache.metrics.reset();
		this.queryMetrics.reset();
		this.dbMetrics.reset();
		this.reprojectionMetrics.calls = 0;
		this.reprojectionMetrics.schemasReprojected = 0;
		this.reprojectionMetrics.rowsScanned = 0;
		this.reprojectionMetrics.blocksUpdated = 0;
		this.reprojectionMetrics.msTotal = 0;
		this.reprojectionMetrics.skippedByMarker = 0;
		this.reprojectionMetrics.skippedByAbsence = 0;
		this.slowestTx = {
			description: null,
			ms: 0
		};
		this.txLog.length = 0;
	}
	/** Get a `Block` facade for `id`. Sync — does NOT load. Read access
	*  on the returned facade (`block.data`, `block.peek()`, etc.) is gated
	*  by what's in cache; call `block.load()` or `repo.load(id)` first
	*  for guaranteed availability. The same `Block` instance is returned
	*  on repeat calls so identity-based React keys / memo work. */
	block(id) {
		let cached = this.blockFacades.get(id);
		if (!cached) {
			cached = new Block(this, id);
			this.blockFacades.set(id, cached);
		}
		return cached;
	}
	/** Load a row + (optionally) a neighborhood into the cache. Spec §5.2.
	*
	*    repo.load(id)                          → just the row
	*    repo.load(id, {children: true})        → row + immediate children
	*    repo.load(id, {ancestors: true})       → row + full parent chain
	*    repo.load(id, {descendants: N})        → row + subtree clipped at
	*                                              depth N (or whole tree
	*                                              if N is omitted/falsy
	*                                              for descendants:true)
	*
	*  Hydrates rows into the cache so subsequent `block.peek()` /
	*  `block.data` calls succeed. Collection reactivity (children /
	*  subtree handles) is owned by the HandleStore, not this loader —
	*  use `repo.query.children({id}).load()` if you want a
	*  handle-cached child-rows list with structural invalidation.
	*
	*  Concurrency note: this method does NOT dedup concurrent loads. An
	*  id-only in-flight cache would silently merge a plain `repo.load(id)`
	*  with a concurrent `repo.load(id, {children: true})` — the second
	*  caller would see the plain promise resolve and miss the children.
	*  Load-dedup that matters for Suspense lives one layer up, at the
	*  `Block` facade (`block.load()`, keyed by Block identity). Inlining
	*  here costs at most one extra row read per concurrent caller; the
	*  cache's `setSnapshot` is fingerprint-deduplicated so listeners
	*  don't fire twice. */
	async load(id, opts) {
		const row = await this.db.getOptional("SELECT * FROM blocks WHERE id = ? AND deleted = 0", [id]);
		if (row === null) {
			this.cache.markMissing(id);
			return null;
		}
		const data = parseBlockRow(row);
		this.cache.applyIfNewer(data, "hydrate");
		if (opts?.children) await this.hydrateChildren(id);
		if (opts?.ancestors) {
			const ancestorRows = await this.db.getAll(ANCESTORS_SQL, [id, id]);
			for (const r of ancestorRows) this.cache.applyIfNewer(parseBlockRow(r), "hydrate");
		}
		if (opts?.descendants) {
			const subtreeRows = await this.db.getAll(SUBTREE_SQL, [id]);
			const maxDepth = typeof opts.descendants === "number" ? opts.descendants : Infinity;
			for (const r of subtreeRows) {
				if (r.depth > maxDepth) continue;
				this.cache.applyIfNewer(parseBlockRow(r), "hydrate");
			}
		}
		return data;
	}
	/** Async existence check — cache-first, falls back to a single SQL
	*  hit. Soft-deleted rows count as MISSING here so create/restore
	*  flows on the caller side get the consistent "not found" signal.
	*  The cache holds tombstone snapshots after `tx.delete` (so peek
	*  can show `deleted: true`); `hasSnapshot` alone would falsely
	*  report a tombstoned row as existing, hence the `deleted` gate. */
	async exists(id) {
		const cached = this.cache.getSnapshot(id);
		if (cached !== void 0) return !cached.deleted;
		return await this.db.getOptional(SELECT_BLOCK_BY_ID_SQL, [id]) !== null;
	}
	/** UI-visible "active" workspace pin — used by plugin hooks and
	*  panels that need a default workspace when there's no other
	*  context. `repo.tx` does NOT consult this; tx workspaces come from
	*  the first write's row per spec §5.3. */
	get activeWorkspaceId() {
		return this._activeWorkspaceId;
	}
	setActiveWorkspaceId(workspaceId) {
		this._activeWorkspaceId = workspaceId;
	}
	/** The active workspace's undo / redo manager — what cmd-Z and the
	*  Undo UI act on (issue #186). Because each workspace has its own
	*  manager, callers can use the plain `peekUndo` / `popUndo` API and it
	*  is implicitly scoped to the active workspace; switching workspace
	*  swaps which manager this returns without disturbing the others.
	*  When no workspace is active, returns a stable throwaway manager
	*  (keyed by `NO_ACTIVE_WORKSPACE`) so callers don't have to null-check
	*  — `undo()` / `redo()` still guard on `activeWorkspaceId`. */
	get undoManager() {
		return this.undoManagerFor(this._activeWorkspaceId ?? NO_ACTIVE_WORKSPACE);
	}
	/** Undo manager for a specific workspace, lazily created. `repo.tx`
	*  records into the tx's pinned workspace's manager so history follows
	*  the workspace, not the (possibly since-changed) active pin. Public
	*  for the rare caller that must address a *known* workspace regardless
	*  of which is currently active — e.g. the SRS reschedule toast, which
	*  captures the rescheduled block's workspace so a workspace switch
	*  during the reschedule's await can't rebind the toast to the wrong
	*  stack. Most callers want `undoManager` (the active one). */
	undoManagerFor(workspaceId) {
		let manager = this.undoManagers.get(workspaceId);
		if (!manager) {
			manager = new UndoManager();
			this.undoManagers.set(workspaceId, manager);
		}
		return manager;
	}
	/** Toggle read-only mode. Wrapping the field write in a method
	*  keeps call sites that come from inside React hooks lint-clean
	*  (`react-hooks/immutability` flags direct property writes on
	*  hook outputs). UI-state and UserPrefs writes still pass through
	*  and upload regardless of this flag; only `BlockDefault` /
	*  `References` writes are rejected. */
	setReadOnly(value) {
		this.isReadOnly = value;
	}
	/** Run a transactional session. Spec §3, §10. */
	async tx(fn, opts) {
		const result = await this._runAndDispatch(fn, opts);
		if (result.workspaceId !== null) this.undoManagerFor(result.workspaceId).record({
			scope: opts.scope,
			txId: result.txId,
			snapshots: result.snapshots,
			description: opts.description
		});
		return result.value;
	}
	/** Undo the most recent committed `repo.tx` for `scope` *in the active
	*  workspace*. Default scope is `BlockDefault` (the cmd-Z target).
	*  Resolves to true if an entry was popped + replayed, false if there
	*  is no active workspace or its manager has no entry for `scope`.
	*
	*  Undo is per-workspace (issue #186): each workspace has its own
	*  `UndoManager`, and we operate on the active one — so a workspace
	*  switch (in-place, no reload) can never revert (or re-upload) an edit
	*  in a workspace the user has left, and switching back restores that
	*  workspace's history. The active manager is captured up front so a
	*  switch mid-replay can't redirect the redo push to a different
	*  workspace's manager.
	*
	*  Replay opens its own `repo.tx` with `source = 'user'` so the
	*  inverse syncs upstream just like the original write did (per the
	*  spec's §7.3 + the follow-ups doc's "undo of a content edit
	*  should sync the un-edit"). The replayed entry belongs to the active
	*  workspace, so the active workspace's read-only flag
	*  (`this.isReadOnly`) is the entry's own workspace read-only —
	*  viewing a read-only workspace B can never block undo of an editable
	*  workspace A's edit, because cmd-Z in B operates on B's (empty)
	*  manager, not A's (issue #186 A5b). Throws `ReadOnlyError` when the
	*  active workspace is read-only for scopes that cannot write locally.
	*  (Known pre-existing limitation: `isReadOnly` is updated by an async
	*  App effect, so it can briefly lag a just-switched-to workspace; a
	*  cmd-Z in that window may transiently `ReadOnlyError`, but the entry
	*  is pushed back so a retry once the flag settles succeeds — see
	*  issue #226.) */
	async undo(scope = ChangeScope.BlockDefault) {
		if (this._activeWorkspaceId === null) return false;
		const manager = this.undoManager;
		const entry = manager.popUndo(scope);
		if (entry === null) return false;
		try {
			await this._replay(entry, "before");
			manager.pushRedo(scope, entry);
			return true;
		} catch (err) {
			manager.pushUndo(scope, entry);
			throw err;
		}
	}
	/** Redo the most recently undone tx for `scope` in the active
	*  workspace. Same defaults + same per-workspace + read-only
	*  semantics as `undo`, mirrored. */
	async redo(scope = ChangeScope.BlockDefault) {
		if (this._activeWorkspaceId === null) return false;
		const manager = this.undoManager;
		const entry = manager.popRedo(scope);
		if (entry === null) return false;
		try {
			await this._replay(entry, "after");
			manager.pushUndo(scope, entry);
			return true;
		} catch (err) {
			manager.pushRedo(scope, entry);
			throw err;
		}
	}
	/** Shared `runTx` + processor-dispatch path. Used by both `tx`
	*  (records on undo stack) and `_replay` (does not).
	*
	*  Storage-layer integrity errors are translated to user-domain
	*  exceptions here so every caller — `repo.tx`, `repo.undo`,
	*  `repo.redo` — surfaces the same shape. Currently:
	*    - `alias_collision` RAISE → `ProcessorRejection('alias.collision',
	*      …)` via the trigger on `block_aliases`.
	*    - `parent_deleted` RAISE → `ParentDeletedError(parentId)` via the
	*      trigger on `blocks` — kept as a typed error rather than a
	*      ProcessorRejection because no toast surface is wired for it and
	*      existing callers `instanceof`-check the class.
	*  Listeners (`onUserError`) fire on translated ProcessorRejections
	*  here so the toast layer sees collisions from undo/redo replay,
	*  not just from `repo.tx` directly. */
	async _runAndDispatch(fn, opts, isReplay = false) {
		const txT0 = performance.now();
		let result;
		try {
			result = await runTx({
				db: this.db,
				cache: this.cache,
				fn,
				opts,
				user: this.user,
				isReadOnly: this.isReadOnly,
				newTxId: this.newId,
				newTxSeq: this.newTxSeq,
				newId: this.newId,
				now: this.now,
				mutators: this.mutators,
				processors: this.processors,
				sameTxProcessors: this.sameTxProcessors,
				propertySchemas: this._propertySchemas,
				isReplay
			});
		} catch (err) {
			const collision = parseAliasCollisionError(err);
			if (collision !== null) {
				const rejection = await this.buildAliasCollisionRejection(collision);
				this.userErrorListeners.notify(rejection);
				throw rejection;
			}
			const parentDeleted = parseParentDeletedError(err);
			if (parentDeleted !== null) throw new ParentDeletedError(parentDeleted.parentId);
			if (err instanceof ProcessorRejection) this.userErrorListeners.notify(err);
			throw err;
		}
		const txMs = performance.now() - txT0;
		const description = opts.description ?? null;
		if (txMs > this.slowestTx.ms) this.slowestTx = {
			description,
			ms: txMs
		};
		this.txLog.push({
			description,
			ms: txMs
		});
		if (this.txLog.length > TX_LOG_CAPACITY) this.txLog.shift();
		if (result.snapshots.size > 0) this.handleStore.invalidate(snapshotsToChangeNotification(result.snapshots, this.invalidationRules));
		this.processorRunner.dispatch({
			txId: result.txId,
			user: result.user,
			workspaceId: result.workspaceId,
			snapshots: result.snapshots,
			afterCommitJobs: result.afterCommitJobs,
			processors: result.processors,
			propertySchemas: result.propertySchemas
		});
		return result;
	}
	/** Replay an undo / redo entry. Opens a tx in the entry's scope and
	*  raw-applies each (id → snap.before) (undo) or (id → snap.after)
	*  (redo) via the engine-internal `applyRaw` primitive. Replays do
	*  NOT push themselves onto the undo stack — the caller manages
	*  stack motion (manager.pushRedo / manager.pushUndo) so the same
	*  entry shuttles symmetrically between stacks. */
	async _replay(entry, direction) {
		const action = direction === "before" ? "undo" : "redo";
		const description = entry.description ? `${action}: ${entry.description}` : action;
		await this._runAndDispatch(async (tx) => {
			const txImpl = tx;
			for (const [id, snap] of entry.snapshots) await txImpl.applyRaw(id, snap[direction]);
		}, {
			scope: entry.scope,
			description
		}, true);
	}
	/** Dynamic dispatch — used by runtime-loaded plugins where the
	*  TypeScript identity isn't available. `name` is the full mutator
	*  name (e.g. `'tasks:setDueDate'` or `'core.indent'`). Args are
	*  validated at the boundary via the mutator's argsSchema. */
	async run(name, args) {
		return this.dispatchMutator(name)(args);
	}
	/** Dynamic query dispatch — `repo.query[name]` for runtime-loaded
	*  plugins. Resolves the query, runs `.load()`, and returns the
	*  result. The same `core.${name}` shortcut as the proxy applies. */
	async runQuery(name, args) {
		return this.dispatchQuery(name)(args).load();
	}
	resolveTypedBlockQuery(query) {
		return normalizeTypedBlockQuery({
			workspaceId: query.workspaceId,
			types: query.types,
			where: query.where,
			referencedBy: query.referencedBy,
			match: query.match,
			exclude: query.exclude,
			order: query.order
		});
	}
	/** Run a typed block query once. `workspaceId` is required: callers
	*  that want the user's currently-active workspace use
	*  `queryActiveWorkspace` instead — making the workspace explicit at
	*  the call site prevents background flows / import runs from silently
	*  mis-scoping on a workspace switch (PR #47 review). */
	async queryBlocks(query) {
		return this.query.typedBlocks(this.resolveTypedBlockQuery(query)).load();
	}
	/** Subscribe to a typed block query. `workspaceId` is required: callers
	*  that want the user's currently-active workspace use
	*  `subscribeActiveWorkspace` instead. */
	subscribeBlocks(query, listener) {
		const handle = this.query.typedBlocks(this.resolveTypedBlockQuery(query));
		const current = handle.peek();
		if (current !== void 0) queueMicrotask(() => listener(current));
		return handle.subscribe(listener);
	}
	/** Active-workspace shorthand for `queryBlocks`. Resolves
	*  `activeWorkspaceId` at call time; if no workspace is active,
	*  returns an empty list (mirrors the historical fallback behaviour
	*  for the rare callers that legitimately want "whatever the user is
	*  looking at right now"). Most non-UI code should NOT use this —
	*  prefer the bare `queryBlocks` with an explicit workspaceId. */
	async queryActiveWorkspace(query) {
		const workspaceId = this.activeWorkspaceId;
		if (!workspaceId) return [];
		return this.queryBlocks({
			...query,
			workspaceId
		});
	}
	/** Active-workspace shorthand for `subscribeBlocks`. Same caveat as
	*  `queryActiveWorkspace`: the workspace is captured at subscription
	*  time and does NOT re-resolve on later workspace switches. UI
	*  surfaces that need switch-following behaviour should resubscribe
	*  themselves when `activeWorkspaceId` changes (e.g. via
	*  `useActiveWorkspaceId`). */
	subscribeActiveWorkspace(query, listener) {
		const workspaceId = this.activeWorkspaceId;
		if (!workspaceId) {
			queueMicrotask(() => listener([]));
			return () => {};
		}
		return this.subscribeBlocks({
			...query,
			workspaceId
		}, listener);
	}
	/** Count non-deleted blocks in `workspaceId` whose `properties` map
	*  has a value at `name`. Used by the property-schema editor to warn
	*  the user before deleting a schema definition that's still in use.
	*  Workspace defaults to the active one; missing workspace returns 0. */
	async countBlocksUsingProperty(name, workspaceId) {
		const wsId = workspaceId ?? this.activeWorkspaceId;
		if (!wsId) return 0;
		return (await this.db.getOptional(`
        SELECT COUNT(*) AS count
        FROM blocks b
        WHERE b.workspace_id = ?
          AND b.deleted = 0
          AND json_extract(b.properties_json, ?) IS NOT NULL
      `, [wsId, jsonPathForProperty(name)]))?.count ?? 0;
	}
	/** Read-only handle on the currently-installed FacetRuntime. Used by
	*  non-React callers that need to consult facets at action-handler
	*  time (e.g. `pickBlockDateAdapter` from a multi-select handler
	*  where `useAppRuntime()` isn't available). Returns null before the
	*  first `setFacetRuntime` call. Delegates to `FacetBridge` (D1(c)).
	*
	*  NOTE: this also serves as the carrier of *app-layer* facets for
	*  callers outside React — `AppRuntimeProvider` installs the merged
	*  app runtime here (so plugin mutators/processors reach the data
	*  registries), and e.g. `surfaceProcessorRejection` reads app-only
	*  facets (`rejectionToastFacet`) off it at error-fan-out time. That
	*  contract holds under the current replace-the-world model; a runtime
	*  refactor that stops installing the full app runtime here must keep
	*  "repo.facetRuntime carries app facets" or relocate those reads —
	*  otherwise they go silently empty. */
	get facetRuntime() {
		return this.facetBridge.facetRuntime;
	}
	/** Update the data-layer registries from a FacetRuntime (spec §8) via
	*  the facet bridge. The bridge decomposes the swap into named rebuild
	*  steps that write back into this Repo's registries, preserving the
	*  replay → rebuild → listeners ordering. Kernel mutators must be
	*  present in the runtime if the caller wants them — pass them in via
	*  the static-facet bundle the kernel ships. */
	setFacetRuntime(runtime) {
		this.facetBridge.setFacetRuntime(runtime);
	}
	/** Replace the runtime contribution bucket for `facet` keyed by
	*  `sourceId`. Triggers a re-run of every rebuild step whose declared
	*  inputs include this facet, plus per-facet listener fan-out for React
	*  subscribers (e.g. usePropertySchemas). Throws if no FacetRuntime has
	*  been installed yet — callers must setFacetRuntime first.
	*
	*  OWNERSHIP CONTRACT: the bucket is DURABLE — it survives `setFacetRuntime`
	*  swaps via `FacetRuntime.adoptDurableContributionsFrom`, and the Repo is a
	*  per-user singleton reused across workspace switches. A writer that owns a
	*  workspace-scoped bucket (e.g. `UserSchemasService` / `UserTypesService`)
	*  MUST clear it — `setRuntimeContributions(facet, sourceId, [])` — when it
	*  tears down on a workspace switch, or the previous workspace's data is
	*  adopted into the next workspace's runtime until the new bucket rebuilds.
	*  (This is the leak fixed in `UserSchemasService.dispose`.) */
	setRuntimeContributions(facet, sourceId, contributions) {
		this.facetBridge.setRuntimeContributions(facet, sourceId, contributions);
	}
	/** Subscribe to changes on `_propertySchemas`. Fires when
	*  `setFacetRuntime` rebuilds the schema map AND when
	*  `setRuntimeContributions(propertySchemasFacet, ...)` updates the
	*  user-data bucket. Used by `usePropertySchemas` so React rerenders
	*  on user-schema add/edit/remove without a runtime swap. */
	onPropertySchemasChange(listener) {
		return this.facetBridge.onPropertySchemasChange(listener);
	}
	/** Subscribe to changes on `_types`. Fires whenever the rebuild step
	*  that owns `_types` re-runs — i.e. after `setFacetRuntime` AND
	*  after `setRuntimeContributions(typesFacet, ...)` publishes into
	*  the user-data bucket. Symmetric to `onPropertySchemasChange`.
	*  Consumers (e.g. `createTypeBlock` waiting for `UserTypesService`
	*  to publish a freshly-committed type-definition block) recheck
	*  `repo.types` inside the listener; spurious firings are tolerated. */
	onTypesChange(listener) {
		return this.facetBridge.onTypesChange(listener);
	}
	/** Subscribe to changes on the merged `propertyEditorOverrides` map
	*  (currently driven exclusively by `propertyEditorOverridesFacet`,
	*  but exposed as a Repo-level event so future runtime-contribution
	*  paths layer on without changing the consumer surface). */
	onPropertyEditorOverridesChange(listener) {
		return this.facetBridge.onPropertyEditorOverridesChange(listener);
	}
	/** Subscribe to changes on the value-preset map. */
	onValuePresetsChange(listener) {
		return this.facetBridge.onValuePresetsChange(listener);
	}
	/** Subscribe to user-surfaceable errors thrown from `repo.tx`
	*  (currently `ProcessorRejection` from same-tx processors). The
	*  data layer fires; the UI layer (e.g. toast) listens. Returns an
	*  unsubscribe fn. Listener exception isolation is handled by
	*  `CallbackSet.notify` — one bad listener can't poison the others
	*  or break the underlying `repo.tx` error propagation. */
	onUserError(listener) {
		return this.userErrorListeners.add(listener);
	}
	/** Translate a parsed alias-collision RAISE into a fully-populated
	*  `ProcessorRejection`. Runs after the user tx has already rolled
	*  back, so `block_aliases` is back to the pre-tx state — the
	*  conflicting claimant is still indexed and one PK lookup away. */
	async buildAliasCollisionRejection(collision) {
		const claimantRow = await this.db.getOptional(SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL, [
			collision.workspaceId,
			collision.alias,
			collision.attemptedBlockId
		]);
		const claimant = claimantRow === null ? null : parseBlockRow(claimantRow);
		const attemptedRow = await this.db.getOptional("SELECT id FROM blocks WHERE id = ?", [collision.attemptedBlockId]);
		return new ProcessorRejection(`Alias "${collision.alias}" is already used by another block`, "alias.collision", {
			alias: collision.alias,
			conflictingBlockId: claimant?.id ?? null,
			conflictingBlockTitle: claimant?.content.slice(0, 80) ?? "",
			workspaceId: collision.workspaceId,
			attemptedOn: collision.attemptedBlockId,
			...attemptedRow === null ? { collisionOrigin: "create" } : {}
		});
	}
	snapshotTypeRegistries() {
		return {
			types: this._types,
			propertySchemas: this._propertySchemas
		};
	}
	async reprojectRefTypedProperties(propertyNames, propertySchemas, workspaceId) {
		if (this.isReadOnly || propertyNames.length === 0 || !workspaceId) return;
		const t0 = performance.now();
		let blocksUpdated = 0;
		let scanScheduled = false;
		try {
			const liveSchemasAtGate = this._activeWorkspaceId === workspaceId ? this._propertySchemas : propertySchemas;
			const markers = await this.reprojectionMarkers.load();
			const namesToScan = [];
			let skippedByMarker = 0;
			let skippedByAbsence = 0;
			for (const name of propertyNames) {
				if (refCodecKind(propertySchemas.get(name)) !== void 0 && markers.has(reprojectionMarkerKey(workspaceId, name))) {
					skippedByMarker += 1;
					continue;
				}
				if (!propertySchemas.has(name) && !liveSchemasAtGate.has(name)) {
					skippedByAbsence += 1;
					continue;
				}
				namesToScan.push(name);
			}
			this.reprojectionMetrics.skippedByMarker += skippedByMarker;
			this.reprojectionMetrics.skippedByAbsence += skippedByAbsence;
			if (namesToScan.length === 0) return;
			scanScheduled = true;
			this.reprojectionMetrics.calls += 1;
			this.reprojectionMetrics.schemasReprojected += namesToScan.length;
			const placeholders = namesToScan.map(() => "?").join(", ");
			const rows = await this.db.getAll(`
          SELECT DISTINCT ${buildQualifiedBlockColumnsSql("b")}
          FROM blocks b, json_each(b.properties_json) prop
          WHERE b.deleted = 0
            AND b.workspace_id = ?
            AND prop.key IN (${placeholders})
        `, [workspaceId, ...namesToScan]);
			this.reprojectionMetrics.rowsScanned += rows.length;
			const liveSchemas = this._activeWorkspaceId === workspaceId ? this._propertySchemas : propertySchemas;
			const blocksByWorkspace = /* @__PURE__ */ new Map();
			for (const row of rows) {
				const block = parseBlockRow(row);
				const blocks = blocksByWorkspace.get(block.workspaceId) ?? [];
				blocks.push(block);
				blocksByWorkspace.set(block.workspaceId, blocks);
			}
			for (const blocks of blocksByWorkspace.values()) await this.tx(async (tx) => {
				for (const block of blocks) {
					const liveBlock = await tx.get(block.id);
					if (liveBlock === null || liveBlock.deleted) continue;
					const projected = namesToScan.flatMap((name) => projectedRefsForField(liveBlock, latestRefProjectionSchema(propertySchemas, liveSchemas, name), name));
					const reconciled = reconcileDerived({
						prior: liveBlock.references,
						recomputed: projected,
						keyOf: derivedRefKey
					});
					if (devAssertionsEnabled()) {
						const nextKeys = new Set(reconciled.map(derivedRefKey));
						for (const ref of liveBlock.references) if (!nextKeys.has(derivedRefKey(ref))) throw new Error(`[reprojection] add-only violated: block ${liveBlock.id} dropped ref ${ref.sourceField ?? ""}/${ref.id}`);
					}
					if (reconciled.length === liveBlock.references.length) continue;
					await tx.update(liveBlock.id, { references: reconciled }, { skipMetadata: true });
					blocksUpdated += 1;
				}
			}, {
				scope: ChangeScope.References,
				description: "reproject ref-typed properties after schema swap"
			});
			for (const name of namesToScan) if (refCodecKind(latestRefProjectionSchema(propertySchemas, liveSchemas, name)) === void 0) await this.reprojectionMarkers.clear(reprojectionMarkerKey(workspaceId, name));
			else await this.reprojectionMarkers.set(reprojectionMarkerKey(workspaceId, name));
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[setFacetRuntime] ref-typed property reprojection failed: ${reason}`);
		} finally {
			this.reprojectionMetrics.blocksUpdated += blocksUpdated;
			if (scanScheduled) this.reprojectionMetrics.msTotal += performance.now() - t0;
		}
	}
	/** Defer reprojection off the cold-start critical path. The first
	*  cold start on a fresh device (or one whose `client_schema_state`
	*  was wiped) has no markers in place yet, so reprojection scans
	*  every block whose properties_json mentions any ref-typed name —
	*  ~1.4 s on a real graph, holding the SQLite connection and
	*  blocking every read issued during page render. The references
	*  processor handles every write that lands during the deferral
	*  window, so projection correctness is preserved.
	*
	*  Deferred via `scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE)` (see
	*  `reprojectionJobs`): off the cold-start window (10 s floor) but
	*  force-run by a 30 s fallback so a never-idle session still gets its
	*  catch-up scan. Test / Node path is `setTimeout(0)` so vitest fake
	*  timers can advance the call deterministically. */
	scheduleReprojection(names, schemas) {
		const workspaceId = this._activeWorkspaceId;
		if (!workspaceId) return;
		this.reprojectionJobs.schedule(() => this.reprojectRefTypedProperties(names, schemas, workspaceId));
	}
	/** Test escape hatch — drop the in-memory marker mirror so the next
	*  reprojection re-reads from `client_schema_state`. Used by tests
	*  that mutate the table out-of-band to simulate cross-session state. */
	__resetReprojectionMarkerCache() {
		this.reprojectionMarkers.reset();
	}
	/**
	* Ensure every registered system page (`systemPagesFacet`) exists for
	* `workspaceId`. Called at workspace bootstrap BEFORE the landing resolver
	* seeds, so a `[[reserved alias]]` wiki-link (Journal/Properties/Types/
	* Locations) resolves to the canonical page instead of auto-creating a rival
	* that trips `alias.collision`. Each `ensure` get-or-creates at a
	* deterministic id (idempotent), so repeated bootstraps and offline-
	* converging clients all land on the same rows.
	*
	* Reads off this Repo's own `facetRuntime` — which carries the data-layer
	* contributions installed at construction (`staticDataExtensions`) — so no
	* separate runtime resolution is needed. Awaited (not deferred): the pages
	* must exist before the seed's references parse.
	*/
	async ensureSystemPages(workspaceId) {
		if (!workspaceId) return;
		const pages = this.facetRuntime?.read(systemPagesFacet) ?? [];
		await Promise.all(pages.map((page) => page.ensure(this, workspaceId)));
	}
	/**
	* Run the registered workspace backfills (`workspaceBackfillsFacet`) for
	* `workspaceId`. These are the synced-table counterpart to LocalSchema
	* backfills: they write through `repo.tx`, so their rows carry
	* source='user' and actually upload — unlike a raw `db.execute`, which would
	* leave the rows local-only (the daily-note:date sync gap). Deferred off the
	* workspace-open critical path (`scheduleDeepIdle` / `CATCHUP_DEEP_IDLE` —
	* same scheme as `scheduleReprojection`) and gated so each
	* backfill runs at most once per workspace.
	*
	* Call AFTER the access gate confirms the workspace is materializable: a
	* read-only / locked / unverified workspace must not be written (the same
	* reason App.tsx defers bootstrap writes past the gate). Fire-and-forget —
	* returns immediately; tests drain via `awaitWorkspaceBackfills()`.
	*/
	scheduleWorkspaceBackfills(workspaceId) {
		if (this.isReadOnly || !workspaceId || this._workspaceBackfills.length === 0) return;
		const backfills = this._workspaceBackfills;
		this.workspaceBackfillJobs.schedule(() => this.runWorkspaceBackfills(workspaceId, backfills));
	}
	async runWorkspaceBackfills(workspaceId, backfills) {
		const markers = await this.workspaceBackfillMarkers.load();
		for (const backfill of backfills) {
			if (this.isReadOnly) return;
			if (markers.has(workspaceBackfillMarkerKey(workspaceId, backfill.id))) continue;
			const ctx = {
				workspaceId,
				getAll: (sql, params) => this.db.getAll(sql, params),
				tx: (fn, opts) => this.tx(fn, opts)
			};
			try {
				await backfill.run(ctx);
				await this.workspaceBackfillMarkers.set(workspaceBackfillMarkerKey(workspaceId, backfill.id));
			} catch (err) {
				const reason = err instanceof Error ? err.message : String(err);
				console.error(`[workspaceBackfills] "${backfill.id}" failed for workspace ${workspaceId}: ${reason}`);
			}
		}
	}
	/**
	* One-time post-upgrade recovery for the deterministic-id shadow bug. A client
	* that skip-staled the server's authoritative row under an *old* reconcile
	* gate consumed its `blocks_synced_changes` entry, so a normal queue-driven
	* drain never re-evaluates it — the shadow persists across reloads. This
	* re-runs the materialization for the workspace via `drainSyncWorkspace`,
	* which re-reads `blocks_synced` DIRECTLY (bypassing the consumed queue) and
	* re-applies the gate, un-shadowing the server's value on disk.
	*
	* No special mode is needed anymore: with server-enforced `updated_at`
	* monotonicity, the sole gate already lets the server win on any
	* non-equal-non-pending row, and a 0-stamped pristine shadow yields via the
	* stamp-0 exemption. (This replaced the old `healing`-mode rescan, which
	* existed because the legacy strict gate would PROTECT a real-user-stamped
	* shadow as if it were an edit.) The pending + equal-nonzero-stamp guards
	* still hold, so an unsent edit is never lost.
	*
	* Marker-gated to run at most once per (workspace, client); deferred off the
	* open path; windowed + resumable and idempotent (a settled workspace
	* re-scans to no-ops). A 0-stamped pristine shadow heals in the live cache
	* too (the LWW accept, since the server row out-stamps 0); a legacy nonzero
	* shadow heals on disk now and in the cache on the next reload.
	*
	* Call after the access gate (a locked/unverified workspace must not be
	* re-materialized here — its own gate-resolution path runs drainWorkspace).
	*/
	scheduleReconcileRescan(workspaceId) {
		if (!workspaceId) return;
		this.reconcileRescanJobs.schedule(() => this.runReconcileRescan(workspaceId));
	}
	async runReconcileRescan(workspaceId) {
		const key = `${RECONCILE_RESCAN_MARKER_PREFIX}${workspaceId}`;
		if (await this.db.getOptional(SELECT_RECONCILE_RESCAN_MARKER_SQL, [key])) return;
		try {
			await this.drainSyncWorkspace(workspaceId);
			await this.db.execute(RECORD_RECONCILE_RESCAN_MARKER_SQL, [key]);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			console.error(`[reconcileRescan] workspace ${workspaceId} failed (will retry next open): ${reason}`);
		}
	}
	/** Test helper — drains reconcile-rescans whose deferral timer has fired.
	*  Mirror of `awaitWorkspaceBackfills`. */
	async awaitReconcileRescans() {
		await this.reconcileRescanJobs.drain();
	}
	/** Strict: throws `BlockNotFoundForTypeError` if `blockId` is missing
	*  or tombstoned at write time. Use when the caller's correctness
	*  depends on the tag actually landing (orchestration / fan-out
	*  paths). For the lenient variant that silently no-ops on a missing
	*  block, see `addTypeInTxLenient` and (in-tx) the dedicated lenient
	*  entry points. Delegates to `TypeTagger` (audit D1(b)). */
	async addType(blockId, typeId, initialValues = {}) {
		await this.typeTagger.addType(blockId, typeId, initialValues);
	}
	/** Strict in-tx variant. Throws `BlockNotFoundForTypeError` if the
	*  target block is missing or tombstoned. The default for orchestration
	*  code; pair with the lenient variant only when racing a concurrent
	*  delete is legitimate (sync-apply / processor paths). */
	async addTypeInTx(tx, blockId, typeId, initialValues = {}, snapshot) {
		await this.typeTagger.addTypeInTx(tx, blockId, typeId, initialValues, snapshot);
	}
	/** Lenient in-tx variant — silently no-ops if the target block is
	*  missing or tombstoned. Reserved for sync-apply / processor paths
	*  that may legitimately observe a concurrent delete between
	*  pre-tx state and tx-start. New orchestration code should prefer
	*  `addTypeInTx` (strict) so a footgun like the Roam-isa adoption
	*  bug (PR #47) can't be expressed. */
	async addTypeInTxLenient(tx, blockId, typeId, initialValues = {}, snapshot) {
		await this.typeTagger.addTypeInTxLenient(tx, blockId, typeId, initialValues, snapshot);
	}
	async removeType(blockId, typeId) {
		await this.typeTagger.removeType(blockId, typeId);
	}
	async removeTypeInTx(tx, blockId, typeId) {
		await this.typeTagger.removeTypeInTx(tx, blockId, typeId);
	}
	async toggleType(blockId, typeId) {
		await this.typeTagger.toggleType(blockId, typeId);
	}
	async setBlockTypes(blockId, typeIds) {
		await this.typeTagger.setBlockTypes(blockId, typeIds);
	}
	/** Replace the query registry and bump the global `queryEpoch` only when
	*  an existing query was REPLACED or REMOVED — never for a purely
	*  additive swap (new names only). A bump re-keys every query, so the
	*  next lookup of any query gets a fresh handle over the new registry;
	*  existing handles stay at the old epoch and keep serving their captured
	*  snapshot (see `queryEpoch`).
	*
	*  Why additive swaps don't bump: a new query name cannot invalidate any
	*  EXISTING handle's snapshot — every query a live handle captured is
	*  still present and identical, so its result can't have changed and a
	*  fresh lookup of an existing query is safe to reuse the cached handle.
	*  This is the common reload shape (`AppRuntimeProvider`'s base→next swap
	*  adds dynamic-plugin queries while kernel/static instances stay the
	*  same), so it keeps cold start from needlessly re-resolving the visible
	*  tree's unchanged kernel queries.
	*
	*  A replace/remove CAN change a composed result, and we can't tell which
	*  callers compose the changed query (composition is only known by
	*  running a resolver — a per-name scheme misses unobserved compositions
	*  and serves pre-swap code), so we re-key everything via the epoch.
	*
	*  Shadowing add: an added bare name `X` whose `core.X` already exists is
	*  NOT additive-safe — it flips what an existing bare `ctx.run('X')`
	*  resolves to (fallback `core.X` → exact `X`; see `runSubquery` /
	*  `dispatchQuery`). The "captured queries are identical" argument is
	*  about object identity, not name→query RESOLUTION, so we count it as
	*  mutating. (Nothing composes bare names today — all `ctx.run` callers
	*  use fully-qualified names — but the guard keeps the invariant sound.)
	*
	*  Corner: a pre-existing query that conditionally composes a NEWLY-ADDED
	*  (non-shadowing) name won't see it on a fresh lookup until a later
	*  replace/remove bump. That's a stable→dynamic dependency (an
	*  anti-pattern) and it fails loud (`QueryNotRegisteredError` against the
	*  captured registry), never silently stale.
	*
	*  Known limitation (separate, init-layer): cold start is only storm-free
	*  when all data-extension plugins are enabled. The bootstrap swap
	*  (`initRepo`, toggle-BLIND) registers every plugin's data queries; the
	*  base swap (`AppRuntimeProvider`, toggle-AWARE) prunes disabled ones —
	*  a REMOVE → bump → the visible tree re-resolves once. Fixing that needs
	*  bootstrap to know the workspace overrides, which it can't yet. */
	swapQueries(newQueries) {
		let mutated = false;
		for (const [name, newQ] of newQueries) {
			const old = this.queries.get(name);
			if (old !== void 0) {
				if (old !== newQ) {
					mutated = true;
					break;
				}
			} else if (!name.startsWith("core.") && newQueries.has(`core.${name}`)) {
				mutated = true;
				break;
			}
		}
		if (!mutated) {
			for (const oldName of this.queries.keys()) if (!newQueries.has(oldName)) {
				mutated = true;
				break;
			}
		}
		this.queries = newQueries;
		if (mutated) this.queryEpoch++;
	}
	/** Wait until the post-commit processor framework has nothing
	*  pending — useful in tests + scripted scenarios that need
	*  deterministic ordering after a `repo.tx` resolves. Does NOT
	*  advance timers; jobs scheduled with `delayMs` only enter the
	*  pending set when the timer fires. */
	async awaitProcessors() {
		await this.processorRunner.awaitIdle();
	}
	/** Wait until every reprojection whose deferral timer has already
	*  fired has finished writing. Like `awaitProcessors()`, this does
	*  NOT advance timers — a reprojection only enters the pending set
	*  once its `setTimeout`/`requestIdleCallback` callback runs, so
	*  callers using fake timers must advance the clock first. Loops so
	*  that a reprojection settling while we await an earlier one is
	*  still drained. Reprojection runs never schedule further
	*  reprojections, so this terminates. */
	async awaitReprojections() {
		await this.reprojectionJobs.drain();
	}
	/** Wait until every workspace backfill whose deferral timer has already
	*  fired has finished. Mirror of `awaitReprojections` — does NOT advance
	*  timers; fake-timer callers must advance the clock first. */
	async awaitWorkspaceBackfills() {
		await this.workspaceBackfillJobs.drain();
	}
	/** Test-only escape hatch retained for stage-level tests that wire
	*  specific processor sets without a FacetRuntime. */
	__setProcessorsForTesting(processors) {
		this.processors = new Map(processors.map((p) => [p.name, p]));
	}
	/** Test-only mirror of `__setProcessorsForTesting` for same-tx
	*  processors. Used by stage-level tests that need to exercise
	*  the in-tx runner without going through the facet runtime. */
	__setSameTxProcessorsForTesting(processors) {
		this.sameTxProcessors = new Map(processors.map((p) => [p.name, p]));
	}
	/** Build the dispatcher closure for a mutator name. Resolution order:
	*    1. literal `name` (kernel full-name like `'core.indent'`,
	*       plugin full-name like `'tasks:setDueDate'`)
	*    2. `'core.${name}'` (so `repo.mutate.indent` resolves to
	*       `'core.indent'` even though the registry key is full-prefixed)
	*  Throws `MutatorNotRegisteredError` if neither matches. */
	dispatchMutator(name) {
		return async (args) => {
			const m = this.mutators.get(name) ?? this.mutators.get(`core.${name}`);
			if (!m) throw new MutatorNotRegisteredError(name);
			const validated = m.argsSchema.parse(args);
			const scope = typeof m.scope === "function" ? m.scope(validated) : m.scope;
			return this.tx((tx) => tx.run(m, validated), {
				scope,
				description: m.describe?.(validated)
			});
		};
	}
	/** Test-only escape hatch retained for stage 1.3 carryover tests
	*  that wired specific mutator sets without a FacetRuntime. New
	*  tests should prefer `setFacetRuntime` (or `installKernelRuntime:
	*  false` plus `setFacetRuntime`). */
	__setMutatorsForTesting(mutators) {
		this.mutators = new Map(mutators.map((m) => [m.name, m]));
	}
	/** Build the `QueryCtx` handed to a query's `resolve`.
	*
	*  - `dataSink` takes `depend` + the row deps `hydrateBlocks` declares
	*    (both route through it, so a no-op `dataSink` is how `deps:'none'`
	*    suppresses *data* deps in one move).
	*  - `registry` is the query-registry snapshot this resolve is pinned to.
	*    `ctx.run` resolves composed queries from it — NOT `this.queries` —
	*    so an outer query and every query it composes always come from one
	*    consistent version, and a data-driven re-resolve of an existing
	*    handle re-runs against the SAME version even after a later swap
	*    replaced `this.queries`.
	*
	*  For a top-level query `dataSink` is the handle's `ResolveContext` and
	*  `registry` is the snapshot captured at lookup. */
	makeQueryCtx(dataSink, registry, depth) {
		return {
			db: this.db,
			repo: this,
			hydrateBlocks: (rows, opts) => this.hydrateRows(rows, {
				ctx: dataSink,
				declareRowDeps: opts?.declareRowDeps ?? true
			}),
			depend: (dep) => dataSink.depend(dep),
			run: ((name, args, opts) => this.runSubquery(name, args, dataSink, registry, opts?.deps ?? "inherit", depth))
		};
	}
	/** Inline resolution for `QueryCtx.run`. Resolves the query by name
	*  (literal, then `core.${name}`) FROM THE PINNED `registry` SNAPSHOT —
	*  not `this.queries` — so an outer query and everything it composes
	*  resolve at one consistent version even if `this.queries` is later
	*  swapped. Validates args, then runs the resolver with a `QueryCtx`
	*  whose *data* deps route to `parentDataSink` (`inherit`) or a no-op
	*  sink (`none`). No handle is created — the sub-query is a reusable
	*  resolver, not its own cache/invalidation unit. Result is parsed
	*  through the callee `resultSchema` so a composed query honors the same
	*  `Query<Args, Result>` contract as a direct dispatch. */
	async runSubquery(name, args, parentDataSink, registry, deps, parentDepth) {
		const depth = parentDepth + 1;
		if (depth > MAX_QUERY_COMPOSITION_DEPTH) throw new Error(`QueryCtx.run: composition depth exceeded ${MAX_QUERY_COMPOSITION_DEPTH} resolving '${name}' (likely a query composition cycle)`);
		const q = registry.get(name) ?? registry.get(`core.${name}`);
		if (!q) throw new QueryNotRegisteredError(name);
		const childDataSink = deps === "none" ? { depend: () => {} } : parentDataSink;
		const validated = q.argsSchema.parse(args);
		const raw = await q.resolve(validated, this.makeQueryCtx(childDataSink, registry, depth));
		return q.resultSchema.parse(raw);
	}
	/** Build the dispatcher closure for a query name. Same resolution
	*  order as `dispatchMutator`: literal name first, then
	*  `'core.${name}'`. The returned closure validates args via the
	*  query's `argsSchema`, then `getOrCreate`s an identity-stable
	*  `LoaderHandle` keyed by `(queryName, args)`. The loader wraps the
	*  query's `resolve` with a `QueryCtx` that forwards `depend` to the
	*  handle's `ResolveContext` and exposes `db` / `repo` /
	*  `hydrateBlocks`. */
	dispatchQuery(name) {
		return (args) => {
			const registry = this.queries;
			const q = registry.get(name) ?? registry.get(`core.${name}`);
			if (!q) throw new QueryNotRegisteredError(name);
			const validated = q.argsSchema.parse(args);
			const fullName = q.name;
			const key = handleKey(`query:${fullName}@${this.queryEpoch}`, validated);
			return this.handleStore.getOrCreate(key, () => new LoaderHandle({
				store: this.handleStore,
				key,
				loader: async (ctx) => {
					const t0 = performance.now();
					try {
						const raw = await q.resolve(validated, this.makeQueryCtx(ctx, registry, 0));
						return q.resultSchema.parse(raw);
					} finally {
						this.queryMetrics.record(fullName, performance.now() - t0);
					}
				}
			}));
		};
	}
	/** Test-only escape hatch parallel to `__setMutatorsForTesting`.
	*  Bypasses the FacetRuntime so unit tests can register a single
	*  query without standing up a full kernel runtime. Routes through
	*  `swapQueries` so generation bookkeeping stays consistent with
	*  the production `setFacetRuntime` path. */
	__setQueriesForTesting(queries) {
		this.swapQueries(new Map(queries.map((q) => [q.name, q])));
	}
};
//#endregion
export { Repo };

//# sourceMappingURL=repo.js.map