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

import { v4 as uuidv4 } from 'uuid'
import type { FacetRuntime, Facet, WorkspaceRuntimeContributionOptions } from '@/facets/facet'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnySameTxProcessor,
  AnyPropertyEditorOverride,
  AnyPropertySchema,
  AnyQuery,
  AnyValuePresetCore,
  BlockData,
  Mutator,
  MutatorRegistry,
  Query,
  QueryCtx,
  QueryRegistry,
  ResolvedTypedBlockQuery,
  RepoTxOptions,
  TypedBlockQuery,
  TypeContribution,
  TypeRegistrySnapshot,
  Tx,
  Unsubscribe,
  User,
} from '@/data/api'
import {
  ChangeScope,
  MutatorNotRegisteredError,
  ParentDeletedError,
  ProcessorRejection,
  QueryNotRegisteredError,
  derivedRefKey,
  reconcileDerived,
} from '@/data/api'
import {
  latestRefProjectionSchema,
  projectedRefsForField,
  refCodecKind,
} from './internals/refProjection'
import { runTx, type PowerSyncDb } from './internals/commitPipeline'
import { devAssertionsEnabled } from './internals/devAssertions'
import type { BlockCache } from '@/data/blockCache'
import { buildQualifiedBlockColumnsSql, parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { kernelDataExtension } from './kernelDataExtension'
import {
  systemPagesFacet,
  type WorkspaceBackfill,
  type WorkspaceBackfillContext,
} from './facets'
import { ProcessorRunner } from './internals/processorRunner'
import { Block } from './block'
import {
  HandleStore,
  LoaderHandle,
  handleKey,
  snapshotsToChangeNotification,
  type ResolveContext,
} from './internals/handleStore'
import { jsonPathForProperty, normalizeTypedBlockQuery } from './internals/typedBlockQuery'
import {
  DbMetrics,
  QueryMetrics,
  wrapDbWithMetrics,
} from './internals/timingMetrics'
import {
  startBlocksSyncedObserver,
  type BlocksSyncedObserver,
  type BlocksSyncedObserverArgs,
} from '@/data/internals/syncObserver/observer'
import type { MaterializeDeps } from '@/data/internals/syncObserver/materialize'
import type { Materializability } from '@/sync/transform'
import {
  CLEAR_REPROJECT_REF_MARKER_SQL,
  RECORD_REPROJECT_REF_MARKER_SQL,
  REPROJECT_REF_MARKER_PREFIX,
  SELECT_REPROJECT_REF_MARKERS_SQL,
  RECORD_WORKSPACE_BACKFILL_MARKER_SQL,
  WORKSPACE_BACKFILL_MARKER_PREFIX,
  SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,
  RECONCILE_RESCAN_MARKER_PREFIX,
  SELECT_RECONCILE_RESCAN_MARKER_SQL,
  RECORD_RECONCILE_RESCAN_MARKER_SQL,
} from './internals/clientSchema'
import { PendingIdleJobs, MarkerStore } from './internals/idleMarkerJobs'
import {
  parseAliasCollisionError,
  parseParentDeletedError,
  type ParsedAliasCollision,
} from './internals/raiseProtocol'
import { UndoManager, type UndoEntry } from './internals/undoManager'
import { CallbackSet } from '@/utils/callbackSet'
import { scheduleDeepIdle, CATCHUP_DEEP_IDLE } from '@/utils/scheduleIdle'
import type { TxImpl } from './internals/txEngine'
import { ANCESTORS_SQL, CHILDREN_SQL, SUBTREE_SQL } from './internals/treeQueries'
import {
  SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,
  SELECT_BLOCK_BY_ID_SQL,
} from './internals/kernelQueries'
import type { InvalidationRule } from './invalidation'
import { KERNEL_PROPERTY_SEEDS } from './properties'
import { KERNEL_TYPE_CONTRIBUTIONS } from './blockTypes'
import { propertiesPageBlockId } from './propertiesPage'
import { typesPageBlockId } from './typesPage'
import { ProjectorRuntime } from './projectorRuntime'
import {USER_SCHEMAS_PROJECTOR_ID, UserSchemasService} from './userSchemasService'
import { UserTypesService } from './userTypesService'
import { TypeTagger } from './typeTagger'
import { FacetBridge } from './facetBridge'
import type {PropertyDefinitionRegistrySnapshot} from './propertyDefinitionRegistry'
import {
  propertySchemaResolverForWorkspace,
  type PropertySchemaResolver,
} from './internals/propertySchemaResolution'
import { runFreshInitialLoad } from './internals/freshInitialLoad'

/** Convert a `Mutator<Args, Result>` into the `repo.mutate` dispatcher
 *  signature `(args: Args) => Promise<Result>`. Used to project
 *  augmented `MutatorRegistry` entries into precise per-key types on
 *  the proxy field. */
type DispatchFor<M> = M extends Mutator<infer A, infer R>
  ? (args: A) => Promise<R>
  : never

/** Per-key dispatcher types for every mutator known at compile time —
 *  every `MutatorRegistry` member, plus the bare `core.<name>`-stripped
 *  shortcut. Plugins extend this surface by augmenting the
 *  `MutatorRegistry` interface from `@/data/api`; kernel mutators are
 *  augmented in `kernelMutators.ts`. */
type KnownMutateDispatch = {
  [K in keyof MutatorRegistry]: DispatchFor<MutatorRegistry[K]>
} & {
  [K in keyof MutatorRegistry as K extends `core.${infer Bare}`
    ? Bare
    : never]: DispatchFor<MutatorRegistry[K]>
}

/** Proxy contract surface. Known keys (above) get precise typing;
 *  unknown keys fall through the `any` index signature so dynamically
 *  loaded plugins that haven't augmented `MutatorRegistry` are still
 *  callable via `repo.mutate['plugin:foo'](args)`. The runtime
 *  argsSchema validation in `dispatchMutator` stays the source of truth
 *  for safety on those paths. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MutateProxy = KnownMutateDispatch & { [name: string]: (args: any) => Promise<any> }

/** Convert a `Query<Args, Result>` into the `repo.query` dispatcher
 *  signature `(args: Args) => LoaderHandle<Result>`. Mirrors
 *  `DispatchFor` for mutators. Returning the concrete `LoaderHandle<R>`
 *  (not just `Handle<R>`) keeps consistency with the existing
 *  `repo.subtree(id)` / `repo.children(id)` factories. */
type DispatchQueryFor<Q> = Q extends Query<infer A, infer R>
  ? (args: A) => LoaderHandle<R>
  : never

type KnownQueryDispatch = {
  [K in keyof QueryRegistry]: DispatchQueryFor<QueryRegistry[K]>
} & {
  [K in keyof QueryRegistry as K extends `core.${infer Bare}`
    ? Bare
    : never]: DispatchQueryFor<QueryRegistry[K]>
}

/** Proxy contract surface for `repo.query`. Mirrors `MutateProxy`:
 *  known keys (kernel + augmented plugins per `QueryRegistry`) get
 *  precise typing; unknown string keys fall through the `any` index
 *  so dynamically-loaded plugins are still callable via
 *  `repo.query['plugin:foo'](args)`. The argsSchema validation in
 *  `dispatchQuery` is the runtime safety boundary for those paths. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryProxy = KnownQueryDispatch & { [name: string]: (args: any) => LoaderHandle<any> }

const KERNEL_TYPES = new Map(KERNEL_TYPE_CONTRIBUTIONS.map(t => [t.id, t]))
const KERNEL_PROPERTY_SEED_MAP = new Map(KERNEL_PROPERTY_SEEDS.map(seed => [seed.name, seed]))

/** The `repo.mutate` / `repo.query` proxy shape: string property access
 *  returns `dispatch(name)` (a fresh dispatcher closure per access —
 *  fine, the underlying registry lookup is a single Map.get); symbol
 *  access resolves to undefined. One implementation shared by the
 *  constructor's two proxies and the undoGroup facade's grouped
 *  `mutate`, so the shape can't drift between them. */
const nameDispatchProxy = <T,>(dispatch: (name: string) => unknown): T =>
  new Proxy({} as Record<string, unknown>, {
    get: (_target, prop) => (typeof prop === 'string' ? dispatch(prop) : undefined),
  }) as T

/** Bounded ring of recent tx entries surfaced via `repo.metrics().txLog`.
 *  Sized to comfortably cover a cold-start window (a few dozen txs) so
 *  diagnostic dumps right after page load don't lose entries. */
const TX_LOG_CAPACITY = 64

/** Registry key for the per-workspace undo manager when no workspace is
 *  active (issue #186). Workspace ids are UUIDs, so this sentinel can
 *  never collide with a real one. The manager under this key stays empty
 *  in practice — `repo.tx` only records under a pinned (non-null)
 *  workspace and `undo()`/`redo()` no-op when there's no active workspace. */
const NO_ACTIVE_WORKSPACE = '__no_active_workspace__'

/** Max `ctx.run` composition depth before we assume a cycle (a query
 *  composing itself, directly or transitively). Composition chains are
 *  shallow in practice; this just turns a stack overflow into a clear
 *  diagnostic. */
const MAX_QUERY_COMPOSITION_DEPTH = 32

/** Suffix (the part after the `reproject_ref:` prefix) of a per-workspace
 *  reprojection marker. Reprojection is workspace-scoped, so each workspace
 *  records its own "already backfilled name X" marker. Workspace ids are UUIDs
 *  (no colons), so this stays unambiguous even though property names can carry
 *  colons (e.g. `roam:isa`). */
const reprojectionMarkerKey = (workspaceId: string, name: string): string =>
  `${workspaceId}:${name}`

/** Suffix (after the `workspace_backfill:` prefix) of a per-workspace
 *  workspace-backfill completion marker — `<workspaceId>:<backfillId>`. Same
 *  shape/rationale as `reprojectionMarkerKey`. */
const workspaceBackfillMarkerKey = (workspaceId: string, id: string): string =>
  `${workspaceId}:${id}`

export interface RepoOptions {
  db: PowerSyncDb
  cache: BlockCache
  user: User
  /** Read-only mode rejects `BlockDefault` / `References` writes
   *  (`ReadOnlyError`). `UiState` and `UserPrefs` writes still proceed
   *  and upload like any other write — any server-side RLS / FK
   *  rejection lands in the upload-rejection quarantine. Default false. */
  isReadOnly?: boolean
  /** Now provider — default `Date.now`. Injected for test determinism. */
  now?: () => number
  /** UUID provider — default `crypto.randomUUID`. Injected for tests
   *  that want deterministic ids. */
  newId?: () => string
  /** Monotonic INTEGER tx-grouping key provider, written into
   *  `tx_context.tx_seq` and copied to `ps_crud.tx_id` by the upload
   *  triggers. Default: a counter seeded from `Date.now()` so values
   *  never collide with anything from a prior run. Tests can inject a
   *  deterministic counter. */
  newTxSeq?: () => number
  /** When false, skip the construction-time kernel-runtime install so
   *  the Repo starts with empty registries. Default true: the
   *  constructor installs a kernel-only `FacetRuntime`
   *  (`kernelDataExtension`) so `repo.mutate.<kernel>` /
   *  `repo.query.<kernel>` work immediately through the same facet path
   *  a later `setFacetRuntime` uses — no separate per-facet registration
   *  flags. Callers that want to control the registry explicitly either
   *  pass `false` and call `setFacetRuntime` themselves, or just call
   *  `setFacetRuntime` (it REPLACES the kernel install). */
  installKernelRuntime?: boolean
  /** When true (default), the Layout B sync observer is started at
   *  construction time so sync-applied writes — staged into `blocks_synced`
   *  — materialize into the app-visible `blocks` table and invalidate
   *  handles (design doc §9.2). Set false in unit tests that want explicit
   *  control over drain timing — they call `repo.startSyncObserver()`
   *  themselves and `flushSyncObserver()` to settle deterministically. */
  startSyncObserver?: boolean
  /** Options forwarded to the sync observer when started. */
  syncObserverOptions?: SyncObserverOptions
  /** Layout B materialization POLICY — the §6 mode/key resolver (getCek +
   *  getMaterializability). Production (initRepo) passes the real resolver so
   *  e2ee rows decrypt, plaintext copies through, and locked/unpinned
   *  workspaces defer. Omitted in tests, which fall back to the plaintext
   *  copy-through stub below (no key). */
  syncObserverDeps?: MaterializeDeps
}

/** Repo-level knobs for the Layout B sync observer. `db` / `cache` /
 *  `handleStore` / `getInvalidationRules` / `deps` are supplied by the Repo
 *  itself; only these pass through from a caller. */
export type SyncObserverOptions = Pick<
  BlocksSyncedObserverArgs,
  'onCycleDetected' | 'throttleMs' | 'onError'
>

export class Repo {
  readonly db: PowerSyncDb
  readonly cache: BlockCache
  user: User
  /** Read-only mode disables `BlockDefault` / `References` writes;
   *  UI-state and UserPrefs writes still pass through and queue to
   *  ps_crud — server-side rejection (RLS) lands in the rejection
   *  quarantine. Mutate via `repo.setReadOnly(value)` rather than
   *  direct field assignment so callers from inside React hooks don't
   *  trip `react-hooks/immutability` lint (the mutation should travel
   *  through a method, not a property write). */
  isReadOnly: boolean

  private readonly now: () => number
  private readonly newId: () => string
  private readonly newTxSeq: () => number
  private mutators: Map<string, AnyMutator> = new Map()
  private processors: Map<string, AnyPostCommitProcessor> = new Map()
  /** Same-tx processor registry — runs inside the user's
   *  writeTransaction in `runTx`. Kept separate from
   *  `this.processors` (post-commit) because the two have different
   *  ctx shapes and run at different pipeline stages; see
   *  `sameTxProcessorsFacet` doc in `facets.ts`. */
  private sameTxProcessors: Map<string, AnySameTxProcessor> = new Map()
  private queries: Map<string, AnyQuery> = new Map()
  private _types: ReadonlyMap<string, TypeContribution> = KERNEL_TYPES
  private _propertySchemas: ReadonlyMap<string, AnyPropertySchema> = KERNEL_PROPERTY_SEED_MAP
  /** Atomic active-workspace definition snapshot. Null at stage 0 before a
   * workspace pin; identity resolution is unavailable in that state. */
  private _propertyDefinitionRegistry: PropertyDefinitionRegistrySnapshot | null = null
  /** Original declaration-name multiplicity retained so both stage-0 and
   * snapshot-bound plain-schema fallbacks reject seed-owned names. */
  private _propertySeedNameCounts: ReadonlyMap<string, number> = new Map()
  private _propertyEditorOverrides: ReadonlyMap<string, AnyPropertyEditorOverride> = new Map()
  private _valuePresetCores: ReadonlyMap<string, AnyValuePresetCore> = new Map()
  private invalidationRules: readonly InvalidationRule[] = []
  /** Facet→registry bridge (audit D1(c)) — owns the installed
   *  FacetRuntime, the rebuild steps, the per-facet change subscriptions,
   *  and the React-facing schema/type/override/preset change channels.
   *  Constructed in the constructor (the rebuild steps write back into
   *  this Repo's registries through a callback target). */
  private readonly facetBridge: FacetBridge
  /** Listeners for user-surfaceable errors thrown from inside a
   *  `repo.tx` — currently `ProcessorRejection` from same-tx
   *  processors. Subscribers are responsible for the UI side
   *  (toast routing); the data layer stays UI-agnostic. */
  private readonly userErrorListeners = new CallbackSet<[ProcessorRejection]>('Repo.userErrors')
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
  private queryEpoch = 0
  private readonly processorRunner: ProcessorRunner
  /** Type-tagging engine (audit D1(b)) — backs the `addType` /
   *  `removeType` / `toggleType` / `setBlockTypes` delegating methods. */
  private readonly typeTagger: TypeTagger
  /** Per-WORKSPACE undo / redo state (spec §10 step 7, §17 line 2228;
   *  issue #186). Each workspace gets its own `UndoManager` (independent
   *  per-scope stacks), so cmd-Z only ever acts on the workspace the user
   *  is looking at and a switch can never revert an edit in a workspace
   *  they've left — while switching back restores that workspace's
   *  history. The public `undoManager` getter resolves to the active
   *  workspace's manager; `repo.tx` records into the tx's pinned
   *  workspace; `repo.undo` / `repo.redo` pop + replay via
   *  `TxImpl.applyRaw`. */
  private readonly undoManagers = new Map<string, UndoManager>()
  /** Identity-stable Block facades, keyed by id. Block satisfies
   *  Handle<BlockData|null> structurally (spec §5.1, §5.2) — its
   *  row-grain reactivity goes through BlockCache.subscribe directly,
   *  so it doesn't need a HandleStore entry; this map IS its identity
   *  table. */
  private readonly blockFacades = new Map<string, Block>()
  /** Handle registry for query-backed collection factories: `children`,
   *  `subtree`, `ancestors`, plugin queries, etc. Identity rule:
   *  same key → same LoaderHandle instance. GC after `gcTimeMs` of
   *  zero subscribers + zero in-flight loads. The store also walks
   *  invalidation: TxEngine fast path + the Layout B sync observer
   *  call `handleStore.invalidate({…})` to fan out to dep-matching
   *  handles. */
  readonly handleStore: HandleStore = new HandleStore()
  /** Per-PowerSyncDb-call timings (getAll / getOptional / get /
   *  execute / writeTransaction). Populated by the metrics-wrapping
   *  proxy installed around `this.db` at construction. */
  readonly dbMetrics = new DbMetrics()
  /** Per-query-name resolve timings. The dispatcher records each
   *  `loader(ctx)` invocation here keyed by the query's full name. */
  readonly queryMetrics = new QueryMetrics()
  /** Counters for `reprojectRefTypedProperties`. Each call to the
   *  reprojection path increments these — useful when investigating
   *  bootstrap-time write-tx amplification triggered by user/plugin
   *  schema changes. Surfaced through `repo.metrics().reprojection`. */
  private readonly reprojectionMetrics = {
    calls: 0,
    schemasReprojected: 0,
    rowsScanned: 0,
    blocksUpdated: 0,
    msTotal: 0,
    skippedByMarker: 0,
    skippedByAbsence: 0,
  }
  /** Lazy in-memory mirror of the per-name reprojection markers in
   *  `client_schema_state` (rows keyed `reproject_ref:<workspaceId>:<name>`).
   *  Loaded on first reprojection call via a single
   *  `SELECT key … LIKE 'reproject_ref:%'` round-trip; afterwards
   *  `reprojectRefTypedProperties` skips ref-typed names already marked
   *  without further SQL. Constructed in the constructor (needs `this.db`).
   *  Tests / migrations that wipe the table call
   *  `__resetReprojectionMarkerCache` to force a reload. */
  private readonly reprojectionMarkers: MarkerStore
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
  private readonly reprojectionJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** Registered workspace backfills (`workspaceBackfillsFacet` snapshot,
   *  refreshed by the `workspaceBackfills` rebuild step). Run once per
   *  workspace by `scheduleWorkspaceBackfills`. */
  private _workspaceBackfills: readonly WorkspaceBackfill[] = []
  /** Lazy in-memory mirror of the workspace-backfill completion markers in
   *  `client_schema_state` (rows keyed `workspace_backfill:<ws>:<id>`), same
   *  pattern as `reprojectionMarkers`. Constructed in the constructor. */
  private readonly workspaceBackfillMarkers: MarkerStore
  /** In-flight workspace-backfill runs whose deferral timer has fired —
   *  drained by `awaitWorkspaceBackfills()` for deterministic test quiescence,
   *  mirroring `reprojectionJobs`. */
  private readonly workspaceBackfillJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** In-flight one-time reconcile-rescan runs — drained by
   *  `awaitReconcileRescans()`, same pattern. */
  private readonly reconcileRescanJobs = new PendingIdleJobs((fn) => scheduleDeepIdle(fn, CATCHUP_DEEP_IDLE))
  /** Slowest writeTransaction observed since the last reset, by
   *  description (`opts.description` passed to `repo.tx`). Updated only
   *  when a tx exceeds the previous high-water mark, so the field is
   *  cheap to maintain in the hot path. Surfaces through
   *  `repo.metrics().db.slowestTx`. */
  private slowestTx: {description: string | null; ms: number} = {description: null, ms: 0}
  /** Bounded log of recent tx (description, ms) — used to attribute
   *  cold-start `writeTransaction` totals to specific call sites. The
   *  most recent `TX_LOG_CAPACITY` entries are retained; older drops
   *  are silent. Surfaces through `repo.metrics().txLog`. */
  private readonly txLog: Array<{description: string | null; ms: number}> = []
  /** Active Layout B sync observer (design doc §9.2): drains the
   *  `blocks_synced` staging table into the app-visible `blocks` table and
   *  invalidates cache + handles. Replaces the row_events tail. Lazy:
   *  created on first start, replaced on subsequent starts. Tests can
   *  `dispose()` and re-`start` for deterministic flushing. */
  private syncObserver: BlocksSyncedObserver | null = null
  /** §6 mode/key resolver for the observer (undefined ⇒ plaintext stub). Public
   *  so the data-integrity plugin's audit runner can reuse the same resolver for
   *  the divergence decrypt-compare (undefined in tests ⇒ cleartext-only). */
  readonly syncObserverDeps?: MaterializeDeps
  /** Backing field for `activeWorkspaceId` (see getter/setter below). */
  private _activeWorkspaceId: string | null = null
  /** Instance discriminator for memoization keys that need to vary
   *  across Repo instances (e.g. lodash.memoize calls in the panel /
   *  user-page bootstrap). Auto-incremented per construction. */
  private static nextInstanceId = 1
  readonly instanceId: number = Repo.nextInstanceId++

  /** Hydrate a list of `BlockRow`s into the cache + return parsed
   *  BlockData[]. Internal helper for kernel queries. Callers choose
   *  whether returned rows are part of the query result (`row` deps) or
   *  only cache priming (`no row` deps). Accepts readonly so it pairs
   *  cleanly with the QueryCtx plumbing in `dispatchQuery`. */
  private hydrateRows(
    rows: ReadonlyArray<BlockRow>,
    opts: {ctx?: ResolveContext; declareRowDeps?: boolean} = {},
  ): BlockData[] {
    const {ctx, declareRowDeps = Boolean(ctx)} = opts
    const out: BlockData[] = []
    for (const r of rows) {
      const data = parseBlockRow(r)
      this.cache.applyIfNewer(data, 'hydrate')
      if (ctx && declareRowDeps) ctx.depend({kind: 'row', id: data.id})
      out.push(data)
    }
    return out
  }

  get types(): ReadonlyMap<string, TypeContribution> {
    return this._types
  }

  get propertySchemas(): ReadonlyMap<string, AnyPropertySchema> {
    return this._propertySchemas
  }

  get propertyDefinitions(): PropertyDefinitionRegistrySnapshot | null {
    return this._propertyDefinitionRegistry
  }

  /** Internal identity boundary factory. The caller supplies the target row's
   * workspace (the transaction layer owns that fact); resolve() itself accepts
   * only a handle/name and is therefore immune to ambient workspace switches. */
  propertySchemaResolverFor(workspaceId: string): PropertySchemaResolver {
    const snapshot = this._propertyDefinitionRegistry?.workspaceId === workspaceId
      ? this._propertyDefinitionRegistry
      : this.facetBridge.propertyDefinitionRegistryForWorkspace(workspaceId)
    return propertySchemaResolverForWorkspace(
      snapshot,
      workspaceId,
      this._propertySeedNameCounts,
      this._activeWorkspaceId === null || workspaceId === this._activeWorkspaceId,
    )
  }

  get propertyEditorOverrides(): ReadonlyMap<string, AnyPropertyEditorOverride> {
    return this._propertyEditorOverrides
  }

  get valuePresetCores(): ReadonlyMap<string, AnyValuePresetCore> {
    return this._valuePresetCores
  }

  /** Deterministic id of the workspace's Properties page (parent of
   *  all `'property-schema'` blocks). Created lazily by
   *  `getOrCreatePropertiesPage` during workspace bootstrap. */
  get propertiesPageId(): string | null {
    if (!this._activeWorkspaceId) return null
    return propertiesPageBlockId(this._activeWorkspaceId)
  }

  /** Registry + driver for definition-block projectors (the
   *  data-defined "watch a meta-type → mirror into a facet bucket"
   *  pattern, issue #90). The synchronous Repo workspace pin owns the
   *  lifecycle for every projector in `definitionBlockProjectorFacet`.
   *  Each incoming generation exposes an awaitable first-tick prime. The
   *  `userSchemas` / `userTypes` facades read their state through it. */
  readonly projectors: ProjectorRuntime = new ProjectorRuntime(this)

  /** Thin facade over the Repo-owned `'user-schemas'` projector. The
   *  projector runtime owns its lifecycle, contribution state, and indexes;
   *  the Repo pin starts its workspace generation before callers can perform
   *  workspace work. */
  readonly userSchemas: UserSchemasService = new UserSchemasService(this)

  /** Thin facade over the Repo-owned `'user-types'` projector. The projector
   *  runtime owns its lifecycle, contribution state, and indexes. It depends on
   *  `'user-schemas'` (started first) to resolve block-type:properties
   *  refList entries to live property schemas. */
  readonly userTypes: UserTypesService = new UserTypesService(this)

  /** Deterministic id of the workspace's Types page (parent of every
   *  `'block-type'` block in the workspace). Created lazily by
   *  `getOrCreateTypesPage` during workspace bootstrap. */
  get typesPageId(): string | null {
    if (!this._activeWorkspaceId) return null
    return typesPageBlockId(this._activeWorkspaceId)
  }

  /** Run `CHILDREN_SQL` for `parentId` and hydrate every row into the
   *  per-row cache. Shared by the `repo.load(id, {children: true})`
   *  opts path, `repo.children(id)` handle, and the hydrating variant
   *  of `repo.childIds(id)`. Collection-level reactivity is owned by
   *  the `LoaderHandle` returned from `repo.children` / `repo.childIds`
   *  — `BlockCache` doesn't track per-parent "loaded" state. */
  private async hydrateChildren(parentId: string, ctx?: ResolveContext): Promise<BlockData[]> {
    const rows = await this.db.getAll<BlockRow>(CHILDREN_SQL, [parentId])
    return this.hydrateRows(rows, {ctx})
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
  readonly mutate: MutateProxy

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
  readonly query: QueryProxy

  constructor(opts: RepoOptions) {
    // Wrap the raw PowerSyncDb so every read/write call goes through
    // the timing proxy. Internal Repo code, processors, runTx, and the
    // sync observer all consume `this.db` — they all get the wrapped
    // surface for free. External callers that hold the original
    // `opts.db` reference are NOT instrumented; pass `repo.db` if you
    // want timings (or use `repo.runQuery` / `repo.tx` which already
    // route through it). The wrapper has the same shape, so existing
    // type contracts hold.
    this.db = wrapDbWithMetrics(opts.db, this.dbMetrics) as PowerSyncDb
    // Marker stores need the wrapped `this.db`, so they're built here
    // rather than as field initializers (which run before the body).
    this.reprojectionMarkers = new MarkerStore(
      this.db,
      REPROJECT_REF_MARKER_PREFIX,
      SELECT_REPROJECT_REF_MARKERS_SQL,
      RECORD_REPROJECT_REF_MARKER_SQL,
      CLEAR_REPROJECT_REF_MARKER_SQL,
    )
    this.workspaceBackfillMarkers = new MarkerStore(
      this.db,
      WORKSPACE_BACKFILL_MARKER_PREFIX,
      SELECT_WORKSPACE_BACKFILL_MARKERS_SQL,
      RECORD_WORKSPACE_BACKFILL_MARKER_SQL,
    )
    this.syncObserverDeps = opts.syncObserverDeps
    this.cache = opts.cache
    this.user = opts.user
    this.isReadOnly = opts.isReadOnly ?? false
    this.now = opts.now ?? Date.now
    this.newId = opts.newId ?? uuidv4
    // Default tx-seq provider: monotonic counter seeded above any
    // value a prior Repo instance could have written. Date.now() in
    // milliseconds is plenty of headroom (Number.MAX_SAFE_INTEGER /
    // ms-per-day ~= a few hundred thousand years).
    if (opts.newTxSeq) {
      this.newTxSeq = opts.newTxSeq
    } else {
      let seq = Date.now()
      this.newTxSeq = () => ++seq
    }
    // Kernel contributions are installed via the facet runtime at the
    // end of this constructor (see `installKernelRuntime` below) — one
    // registration path shared with `setFacetRuntime`, no per-facet
    // flags and no dual kernel registration (audit B1(1)).
    // Initialize the processor runner. The runner needs a Repo
    // reference for opening processor txs; passing `this` is safe
    // because runner methods only use it post-construction (during
    // dispatch). The runner reads its registry per-tx from the snapshot
    // baked into TxResult — we don't sync a registry into the runner
    // here.
    this.processorRunner = new ProcessorRunner(this, this.db)
    // Type-tagging engine (audit D1(b)). Repo keeps spec-pinned
    // delegating methods over this single instance.
    this.typeTagger = new TypeTagger(this)
    // Facet→registry bridge (audit D1(c)). The rebuild steps write their
    // results back into this Repo's registries through these closures;
    // the bridge owns the runtime, the steps, the per-facet change
    // subscriptions, and the React change channels.
    this.facetBridge = new FacetBridge({
      getPropertySchemas: () => this._propertySchemas,
      getPropertyDefinitionProjector: () => this.propertyDefinitionProjector(),
      applyMutators: (mutators) => { this.mutators = mutators },
      applyProcessors: (processors) => { this.processors = processors },
      applySameTxProcessors: (processors) => { this.sameTxProcessors = processors },
      applyInvalidationRules: (rules) => { this.invalidationRules = rules },
      applyWorkspaceBackfills: (backfills) => { this._workspaceBackfills = backfills },
      applyTypesAndSchemas: (
        types,
        propertySchemas,
        propertyDefinitions,
        propertySeedNameCounts,
      ) => {
        this._types = types
        this._propertySchemas = propertySchemas
        this._propertyDefinitionRegistry = propertyDefinitions
        this._propertySeedNameCounts = propertySeedNameCounts
      },
      applyPropertyEditorOverrides: (overrides) => { this._propertyEditorOverrides = overrides },
      applyValuePresetCores: (presets) => { this._valuePresetCores = presets },
      applyQueries: (queries) => { this.swapQueries(queries) },
      scheduleReprojection: (names, schemas) => { this.scheduleReprojection(names, schemas) },
    })
    this.mutate = nameDispatchProxy<MutateProxy>(name => this.dispatchMutator(name))
    // Identity stability for query handles is provided by the
    // handle-store key inside `dispatchQuery`, not by memoizing the
    // dispatcher itself.
    this.query = nameDispatchProxy<QueryProxy>(name => this.dispatchQuery(name))
    // Install the kernel-only FacetRuntime so the kernel mutators,
    // queries, same-tx processors, invalidation rule, property schemas,
    // and type contributions are live before any `setFacetRuntime` swap
    // (audit B1(1)). This is the SAME path a later swap takes — it
    // REPLACES this install with the merged kernel + plugin registry —
    // so there is exactly one kernel registration path. Reprojection
    // scheduling is gated on an active workspace (none yet at
    // construction), so this does no DB work. Tests/tooling that need
    // empty registries pass `installKernelRuntime: false`.
    if (opts.installKernelRuntime ?? true) {
      this.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension]))
    }
    // Start the Layout B sync observer by default (design doc §9.2).
    // Tests that want deterministic timing pass startSyncObserver: false
    // and call repo.startSyncObserver() + flushSyncObserver() themselves
    // before issuing sync-style writes into `blocks_synced`.
    if (opts.startSyncObserver ?? true) {
      this.startSyncObserver(opts.syncObserverOptions)
    }
  }

  /** Start the Layout B sync observer (design doc §9.2). Idempotent in
   *  spirit: if one is already running, it's disposed first so the new
   *  options take effect. Returns the observer for inspection / manual
   *  flushing. */
  startSyncObserver(options?: SyncObserverOptions): BlocksSyncedObserver {
    if (this.syncObserver) this.syncObserver.dispose()
    this.syncObserver = startBlocksSyncedObserver({
      db: this.db,
      cache: this.cache,
      handleStore: this.handleStore,
      // Production passes the §6 mode/key resolver (initRepo). Tests omit it
      // and fall back to plaintext copy-through with no key — the historical
      // behavior, so non-e2ee tests are unaffected.
      deps: this.syncObserverDeps
        ?? { getMaterializability: (): Materializability => 'copy', getCek: async () => null },
      getInvalidationRules: () => this.invalidationRules,
      onCycleDetected: options?.onCycleDetected,
      throttleMs: options?.throttleMs,
      onError: options?.onError,
    })
    return this.syncObserver
  }

  /** Dispose the active sync observer (no-op if none). Tests use this to
   *  detach the subscription before tearing down the test DB. */
  stopSyncObserver(): void {
    if (this.syncObserver) {
      this.syncObserver.dispose()
      this.syncObserver = null
    }
  }

  /** Manually flush the sync observer — drains any pending `blocks_synced`
   *  changes into `blocks` and walks `handleStore.invalidate(...)`. Tests
   *  use this instead of waiting on the throttle window; it's a real settle
   *  barrier (awaits every drain enqueued before it). */
  async flushSyncObserver(): Promise<void> {
    if (this.syncObserver) await this.syncObserver.flush()
  }

  /** Re-materialize a workspace's staged `blocks_synced` rows after it becomes
   *  materializable (WK pasted / plaintext confirmed via the §8.2 gate). No-op
   *  if the observer isn't running. */
  async drainSyncWorkspace(workspaceId: string): Promise<void> {
    if (this.syncObserver) await this.syncObserver.drainWorkspace(workspaceId)
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
  metrics(): Readonly<{
    handleStore: Readonly<Record<string, number>>
    /** Live-state aggregates over the registered handle set: handle
     *  count, dep-count percentiles, and the top-3 keys by dep count.
     *  Pairs with `handleStore` counters — counters describe events
     *  since the last reset, this describes the store right now. Use
     *  the top-heavy list to spot resolvers that are over-registering
     *  deps. */
    handleStoreInventory: ReturnType<HandleStore['snapshotInventory']>
    blockCache: Readonly<Record<string, number>>
    queries: Readonly<Record<string, ReturnType<QueryMetrics['snapshot']>[string]>>
    db: ReturnType<DbMetrics['snapshot']>
    /** High-water mark across all `repo.tx` calls since the last reset.
     *  Pairs with `db.writeTransaction.maxMs` to attribute outliers to a
     *  concrete description (e.g. 'reproject ref-typed properties after
     *  schema swap'). `description: null` means the slowest tx so far
     *  was opened without a description. */
    slowestTx: Readonly<{description: string | null; ms: number}>
    /** Bounded list of recent (description, ms) entries — the most
     *  recent `TX_LOG_CAPACITY` writeTransactions across the Repo's
     *  lifetime since the last reset. Lets a cold-start metrics dump
     *  attribute every observed writeTransaction sample to a concrete
     *  call site. Order is oldest-to-newest. */
    txLog: ReadonlyArray<Readonly<{description: string | null; ms: number}>>
    reprojection: Readonly<{
      calls: number
      schemasReprojected: number
      rowsScanned: number
      blocksUpdated: number
      msTotal: number
      skippedByMarker: number
      skippedByAbsence: number
    }>
  }> {
    return Object.freeze({
      handleStore: this.handleStore.metrics.snapshot(),
      handleStoreInventory: this.handleStore.snapshotInventory(),
      blockCache: this.cache.metrics.snapshot(),
      queries: this.queryMetrics.snapshot(),
      db: this.dbMetrics.snapshot(),
      slowestTx: Object.freeze({...this.slowestTx}),
      txLog: Object.freeze(this.txLog.map(entry => Object.freeze({...entry}))),
      reprojection: Object.freeze({...this.reprojectionMetrics}),
    })
  }

  /** Zero every counter and reservoir in `repo.metrics()`. Use to
   *  mark a baseline before measuring a discrete operation (e.g. a
   *  benchmark iteration, a UI interaction in a soak test, or a
   *  cold-start "open page → metrics" investigation). */
  resetMetrics(): void {
    this.handleStore.metrics.reset()
    this.cache.metrics.reset()
    this.queryMetrics.reset()
    this.dbMetrics.reset()
    this.reprojectionMetrics.calls = 0
    this.reprojectionMetrics.schemasReprojected = 0
    this.reprojectionMetrics.rowsScanned = 0
    this.reprojectionMetrics.blocksUpdated = 0
    this.reprojectionMetrics.msTotal = 0
    this.reprojectionMetrics.skippedByMarker = 0
    this.reprojectionMetrics.skippedByAbsence = 0
    this.slowestTx = {description: null, ms: 0}
    this.txLog.length = 0
  }

  /** Get a `Block` facade for `id`. Sync — does NOT load. Read access
   *  on the returned facade (`block.data`, `block.peek()`, etc.) is gated
   *  by what's in cache; call `block.load()` or `repo.load(id)` first
   *  for guaranteed availability. The same `Block` instance is returned
   *  on repeat calls so identity-based React keys / memo work. */
  block(id: string): Block {
    let cached = this.blockFacades.get(id)
    if (!cached) {
      cached = new Block(this, id)
      this.blockFacades.set(id, cached)
    }
    return cached
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
  async load(
    id: string,
    opts?: { children?: boolean; ancestors?: boolean; descendants?: boolean | number },
  ): Promise<BlockData | null> {
    const row = await this.db.getOptional<BlockRow>(
      'SELECT * FROM blocks WHERE id = ? AND deleted = 0', [id],
    )
    if (row === null) {
      this.cache.markMissing(id)
      return null
    }
    const data = parseBlockRow(row)
    this.cache.applyIfNewer(data, 'hydrate')

    if (opts?.children) await this.hydrateChildren(id)

    if (opts?.ancestors) {
      // Pass id twice — ANCESTORS_SQL uses it as both start and skip.
      const ancestorRows = await this.db.getAll<BlockRow>(ANCESTORS_SQL, [id, id])
      for (const r of ancestorRows) this.cache.applyIfNewer(parseBlockRow(r), 'hydrate')
    }

    if (opts?.descendants) {
      const subtreeRows = await this.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [id])
      const maxDepth = typeof opts.descendants === 'number' ? opts.descendants : Infinity
      for (const r of subtreeRows) {
        if (r.depth > maxDepth) continue
        this.cache.applyIfNewer(parseBlockRow(r), 'hydrate')
      }
    }

    return data
  }

  /** Async existence check — cache-first, falls back to a single SQL
   *  hit. Soft-deleted rows count as MISSING here so create/restore
   *  flows on the caller side get the consistent "not found" signal.
   *  The cache holds tombstone snapshots after `tx.delete` (so peek
   *  can show `deleted: true`); `hasSnapshot` alone would falsely
   *  report a tombstoned row as existing, hence the `deleted` gate. */
  async exists(id: string): Promise<boolean> {
    const cached = this.cache.getSnapshot(id)
    if (cached !== undefined) return !cached.deleted
    const row = await this.db.getOptional<{id: string}>(SELECT_BLOCK_BY_ID_SQL, [id])
    return row !== null
  }

  // ──── Active-workspace getter/setter (UI bookkeeping) ────

  /** UI-visible "active" workspace pin — used by plugin hooks and
   *  panels that need a default workspace when there's no other
   *  context. `repo.tx` does NOT consult this; tx workspaces come from
   *  the first write's row per spec §5.3. */
  get activeWorkspaceId(): string | null {
    return this._activeWorkspaceId
  }

  setActiveWorkspaceId(workspaceId: string | null): void {
    if (
      workspaceId === this._activeWorkspaceId &&
      (!this.facetRuntime || workspaceId === this.projectors.workspaceId)
    ) return
    this._activeWorkspaceId = workspaceId
    this.facetBridge.setActiveWorkspaceId(workspaceId)
    try {
      if (this.facetRuntime) {
        this.projectors.pinWorkspace(workspaceId)
      }
    } catch (error) {
      // ProjectorRuntime attempts to restore its outgoing generation. If that
      // nested rollback also failed, its honest state is null; mirror that
      // rather than claiming the old workspace and suppressing a retry.
      const restoredWorkspaceId = this.projectors.workspaceId
      this._activeWorkspaceId = restoredWorkspaceId
      this.facetBridge.setActiveWorkspaceId(restoredWorkspaceId)
      throw error
    }
  }

  /** Wait until persisted property definitions have produced their first
   * complete workspace snapshot. Bootstrap calls this before typed writes so
   * declaration synthesis cannot temporarily outrank a stored rename/shadow. */
  async whenPropertyDefinitionsReady(workspaceId: string): Promise<void> {
    const handle = this.propertyDefinitionProjector()
    if (!handle) return
    await handle.whenPrimed(workspaceId)
  }

  private propertyDefinitionProjector() {
    if (!this.facetRuntime) return undefined
    return this.projectors.handle(USER_SCHEMAS_PROJECTOR_ID)
  }

  /** The active workspace's undo / redo manager — what cmd-Z and the
   *  Undo UI act on (issue #186). Because each workspace has its own
   *  manager, callers can use the plain `peekUndo` / `popUndo` API and it
   *  is implicitly scoped to the active workspace; switching workspace
   *  swaps which manager this returns without disturbing the others.
   *  When no workspace is active, returns a stable throwaway manager
   *  (keyed by `NO_ACTIVE_WORKSPACE`) so callers don't have to null-check
   *  — `undo()` / `redo()` still guard on `activeWorkspaceId`. */
  get undoManager(): UndoManager {
    return this.undoManagerFor(this._activeWorkspaceId ?? NO_ACTIVE_WORKSPACE)
  }

  /** Undo manager for a specific workspace, lazily created. `repo.tx`
   *  records into the tx's pinned workspace's manager so history follows
   *  the workspace, not the (possibly since-changed) active pin. Public
   *  for the rare caller that must address a *known* workspace regardless
   *  of which is currently active — e.g. the SRS reschedule toast, which
   *  captures the rescheduled block's workspace so a workspace switch
   *  during the reschedule's await can't rebind the toast to the wrong
   *  stack. Most callers want `undoManager` (the active one). */
  undoManagerFor(workspaceId: string): UndoManager {
    let manager = this.undoManagers.get(workspaceId)
    if (!manager) {
      manager = new UndoManager()
      this.undoManagers.set(workspaceId, manager)
    }
    return manager
  }

  /** Toggle read-only mode. Wrapping the field write in a method
   *  keeps call sites that come from inside React hooks lint-clean
   *  (`react-hooks/immutability` flags direct property writes on
   *  hook outputs). UI-state and UserPrefs writes still pass through
   *  and upload regardless of this flag; only `BlockDefault` /
   *  `References` writes are rejected. */
  setReadOnly(value: boolean): void {
    this.isReadOnly = value
  }

  /** Run a transactional session. Spec §3, §10. */
  async tx<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
  ): Promise<R> {
    // Translation + listener notification happen inside `_runAndDispatch`
    // so all entry points (`tx`, `undo`, `redo`) get uniform error
    // shaping — `repo.tx` just re-throws here.
    const result: Awaited<ReturnType<typeof this._runAndDispatch<R>>> =
      await this._runAndDispatch(fn, opts)
    // Step 7 of the §10 pipeline — record undo entry into the tx's pinned
    // workspace's manager, so a later cmd-Z only ever acts on entries from
    // the workspace the user is looking at (issue #186). Non-undoable
    // scopes are filtered inside `record`; zero-write txs have no pinned
    // workspace (null) and nothing to undo, so skip them here. Replays go
    // through `_replay`, not here, so they don't add new history.
    if (result.workspaceId !== null) {
      this.undoManagerFor(result.workspaceId).record({
        scope: opts.scope,
        txId: result.txId,
        snapshots: result.snapshots,
        description: opts.description,
        // Group token (issue #306): entries sharing it merge at record
        // time while the previous one is still top-of-stack, so a
        // multi-tx composite reverts with one cmd-Z.
        groupId: opts.groupId,
      })
    }
    return result.value
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
  async undo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    if (this._activeWorkspaceId === null) return false
    const manager = this.undoManager
    const entry = manager.popUndo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'before')
      manager.pushRedo(scope, entry)
      return true
    } catch (err) {
      // Replay failed — push the entry back so the user can retry
      // (e.g. after toggling read-only off, fixing a missing parent).
      // Known narrow hazard (pre-existing, issue #226 window): if a new
      // tx recorded during the failed replay's await, this pushback
      // lands the entry ABOVE it — chronologically inverted. With
      // grouping the inversion additionally makes a same-group tx merge
      // into the pushed-back entry rather than the newer one. We keep
      // the groupId on pushback anyway: stripping it would break the
      // legitimate retry path (RescheduleToast re-matches the restored
      // entry by groupId once read-only clears), which is a far more
      // common sequence than a mid-replay same-group commit.
      manager.pushUndo(scope, entry)
      throw err
    }
  }

  /** Redo the most recently undone tx for `scope` in the active
   *  workspace. Same defaults + same per-workspace + read-only
   *  semantics as `undo`, mirrored. */
  async redo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    if (this._activeWorkspaceId === null) return false
    const manager = this.undoManager
    const entry = manager.popRedo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'after')
      manager.pushUndo(scope, entry)
      return true
    } catch (err) {
      manager.pushRedo(scope, entry)
      throw err
    }
  }

  /** Run `fn` against a `Repo`-shaped facade whose every tx carries one
   *  freshly-minted undo-group token (issue #306, docs/undo-grouping.md).
   *  Consecutive txs opened through the facade — directly via
   *  `grouped.tx`, or indirectly via `grouped.mutate.X` / `grouped.run`
   *  — MERGE into a single undo entry at record time, so the whole
   *  composite reverts with one cmd-Z. Helpers that take a `Repo`
   *  parameter join the group simply by being handed the facade.
   *
   *  Wrap-site convention: name the callback parameter `repo`,
   *  shadowing the raw repo — that way an out-of-habit `repo.tx(...)`
   *  inside the group cannot silently open a foreign tx and split it.
   *
   *  Semantics to be aware of:
   *   - Merging is top-of-stack only: a foreign tx (one opened on the
   *     plain repo, e.g. a background write) landing mid-group SPLITS
   *     the group into two entries rather than folding across it.
   *   - No atomicity: each tx still commits independently. If a later
   *     tx throws, the committed prefix stays applied and remains
   *     covered by the (single) group entry; the error propagates.
   *   - Nested `undoGroup` on the facade joins the OUTER group — one
   *     user-perceived action, one entry.
   *   - The facade must not escape the callback: its token never
   *     expires, so a leaked reference would stamp far-future txs into
   *     a long-dead group (see the `block` override below for the one
   *     leak path that existed).
   *   - Grouping covers `tx` / `mutate` / `run` and the TypeTagger
   *     convenience writes. Two write styles deliberately do NOT join:
   *     Block-facade sugar (`grouped.block(id).setContent(...)` routes
   *     through `block.repo` = the real repo — a group-bound Block
   *     would be exactly the leak the `block` override closes) and
   *     stateful service writes (`userSchemas` / `userTypes` /
   *     `projectors` — constructed against the real repo; a
   *     facade-hosted twin would clobber their shared contribution
   *     buckets). Both land as foreign txs and split the group; use
   *     `grouped.tx` / `grouped.mutate` inside a group instead.
   *   - Everything not overridden delegates to the real repo via the
   *     prototype chain and therefore runs with the facade as `this` —
   *     safe for reads and shared-object mutation, NOT safe for three
   *     hazard classes (shared-state minting, instance-field
   *     assignment, construction-captured collaborators), which the
   *     overrides in {@link groupedFacade} cover — each carries its
   *     rationale at the override. The classification rubric and the
   *     structural enforcement live in `repoFacadeGate.test.ts`, which
   *     fails on any Repo member that is neither overridden nor
   *     consciously allowlisted. */
  async undoGroup<R>(fn: (grouped: Repo) => Promise<R>): Promise<R> {
    return fn(this.groupedFacade(this.newId()))
  }

  /** Build the group-injecting facade for {@link undoGroup}. */
  private groupedFacade(groupId: string): Repo {
    const facade = Object.create(this) as Repo
    const tx = <R,>(fn: (tx: Tx) => Promise<R>, opts: RepoTxOptions): Promise<R> =>
      this.tx(fn, {...opts, groupId})
    const run = ((name: string, args: unknown) =>
      this.dispatchMutator(name, groupId)(args)) as Repo['run']
    const mutate = nameDispatchProxy<MutateProxy>(name => this.dispatchMutator(name, groupId))
    // Async so a synchronously-throwing callback rejects like the outer
    // `undoGroup` does instead of throwing through the caller.
    const undoGroup = async <R,>(inner: (grouped: Repo) => Promise<R>): Promise<R> =>
      inner(facade)
    // `block()` on a cache miss mints `new Block(this, id)` into the
    // repo-wide `blockFacades` identity map. With the facade as `this`
    // that would cache a facade-bound Block FOREVER — every later
    // ordinary edit through it (`setContent`, `set`, `delete` route
    // through `block.repo`) would carry this group's token and merge
    // into the long-dead group's entry (one cmd-Z would then revert an
    // unrelated edit plus the whole composite). Mint through the real
    // repo so shared state only ever holds real-repo Blocks.
    const block = (id: string): Block => this.block(id)
    // The TypeTagger convenience writes (`addType` & co.) open their own
    // txs through the tagger's construction-captured host — the REAL
    // repo — so on the facade they would silently escape the group and
    // split it. A facade-hosted tagger (TypeTagger is a stateless
    // wrapper; the facade satisfies TypeTaggerHost structurally, with
    // grouped `tx`) keeps the documented "helpers join by being handed
    // the facade" contract true for them. The `*InTx` variants write
    // into a caller-provided tx and need no override.
    const groupedTagger = new TypeTagger(facade)
    const addType: Repo['addType'] = (blockId, typeId, initialValues = {}) =>
      groupedTagger.addType(blockId, typeId, initialValues)
    const removeType: Repo['removeType'] = (blockId, typeId) =>
      groupedTagger.removeType(blockId, typeId)
    const toggleType: Repo['toggleType'] = (blockId, typeId) =>
      groupedTagger.toggleType(blockId, typeId)
    const setBlockTypes: Repo['setBlockTypes'] = (blockId, typeIds) =>
      groupedTagger.setBlockTypes(blockId, typeIds)
    // Shared-state minting, part 2: `runQuery` (the dynamic dispatch
    // entry point — exactly helper-shaped) would store a LoaderHandle
    // whose loader and QueryCtx capture the facade into the SHARED
    // handle store, where every future invalidation-driven re-resolve
    // would see `ctx.repo` = the long-dead facade. Query resolution is
    // never group-bound; delegate.
    const runQuery: Repo['runQuery'] = (name, args) => this.runQuery(name, args)
    // Deferred-job scheduling captures `this` into shared job queues
    // that fire long after the group's lifetime — a facade-bound job
    // would open GROUPED txs minutes later and merge system writes into
    // the dead entry. Never group-bound; delegate.
    const scheduleWorkspaceBackfills: Repo['scheduleWorkspaceBackfills'] = (ws) =>
      this.scheduleWorkspaceBackfills(ws)
    const scheduleReconcileRescan: Repo['scheduleReconcileRescan'] = (ws) =>
      this.scheduleReconcileRescan(ws)
    // Field-assigning members: run with the facade as `this`, the
    // assignment would create a shadow property on the facade and the
    // real repo would never see it (silent state divergence). Delegate
    // explicitly. `undo`/`redo` belong here because `_runAndDispatch`
    // assigns `slowestTx` mid-flight; the sync-observer pair assigns
    // `syncObserver` (a shadowed stop would strand the real repo with a
    // disposed observer it believes is live).
    const setActiveWorkspaceId: Repo['setActiveWorkspaceId'] = (id) =>
      this.setActiveWorkspaceId(id)
    const setReadOnly: Repo['setReadOnly'] = (value) => this.setReadOnly(value)
    const undo: Repo['undo'] = (scope) => this.undo(scope)
    const redo: Repo['redo'] = (scope) => this.redo(scope)
    const startSyncObserver: Repo['startSyncObserver'] = (options) =>
      this.startSyncObserver(options)
    const stopSyncObserver: Repo['stopSyncObserver'] = () => this.stopSyncObserver()
    const resetMetrics: Repo['resetMetrics'] = () => this.resetMetrics()
    return Object.assign(facade, {
      tx, run, mutate, undoGroup, block, runQuery,
      addType, removeType, toggleType, setBlockTypes,
      scheduleWorkspaceBackfills, scheduleReconcileRescan,
      setActiveWorkspaceId, setReadOnly, undo, redo,
      startSyncObserver, stopSyncObserver, resetMetrics,
    })
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
  private async _runAndDispatch<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
    isReplay = false,
  ) {
    const txT0 = performance.now()
    let result
    // A workspace pin starts the definition projector asynchronously. Delay
    // active-workspace transactions at the one shared boundary so callers
    // cannot capture declaration-only seed winners during that short window.
    // The wait is generation-bound: a workspace switch rejects it instead of
    // letting the queued transaction drift into a different workspace.
    const readinessWorkspaceId = this._activeWorkspaceId
    const readinessGenerationToken = this.projectors.generationToken
    if (readinessWorkspaceId) {
      await this.whenPropertyDefinitionsReady(readinessWorkspaceId)
      if (
        this._activeWorkspaceId !== readinessWorkspaceId
        || this.projectors.generationToken !== readinessGenerationToken
      ) {
        throw new Error(
          `[Repo.tx] active workspace generation changed while waiting for ${readinessWorkspaceId}`,
        )
      }
    }
    const capturedActivePropertyDefinitions = this._propertyDefinitionRegistry
    const capturedPropertyDefinitionFactory =
      this.facetBridge.capturePropertyDefinitionRegistryFactory()
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
        propertyDefinitionRegistryForWorkspace:
          workspaceId => capturedActivePropertyDefinitions?.workspaceId === workspaceId
            ? capturedActivePropertyDefinitions
            : capturedPropertyDefinitionFactory(workspaceId),
        propertySchemaWorkspaceId: this._activeWorkspaceId,
        propertySeedNameCounts: this._propertySeedNameCounts,
        // Undo/redo replays skip the same-tx processor pass so a
        // value-deriving processor can't override `applyRaw`'s exact
        // restore (#187). Post-commit processors still dispatch below.
        isReplay,
      })
    } catch (err) {
      const collision = parseAliasCollisionError(err)
      if (collision !== null) {
        const rejection = await this.buildAliasCollisionRejection(collision)
        this.userErrorListeners.notify(rejection)
        throw rejection
      }
      const parentDeleted = parseParentDeletedError(err)
      if (parentDeleted !== null) {
        throw new ParentDeletedError(parentDeleted.parentId)
      }
      if (err instanceof ProcessorRejection) this.userErrorListeners.notify(err)
      throw err
    }
    // Track the slowest tx by description so cold-start metrics can
    // attribute writeTransaction outliers to a concrete site (e.g.
    // 'reproject ref-typed properties after schema swap', mutator names).
    // Cheaper than recording every tx; only the high-water mark wins.
    const txMs = performance.now() - txT0
    const description = opts.description ?? null
    if (txMs > this.slowestTx.ms) {
      this.slowestTx = {description, ms: txMs}
    }
    // Bounded log of recent tx (description, ms). Drops the oldest
    // entry once `TX_LOG_CAPACITY` is reached. Lets a cold-start
    // metrics dump attribute every writeTransaction sample to a
    // call site, not just the slowest one.
    this.txLog.push({description, ms: txMs})
    if (this.txLog.length > TX_LOG_CAPACITY) this.txLog.shift()
    // TxEngine fast path (spec §9.3 path 1): post-commit, fan-out the
    // tx's snapshots diff to dep-matching collection handles. The
    // commit pipeline already updated the BlockCache (which fires
    // Block.subscribe row-grain listeners) — this layer is just for
    // children/subtree/ancestors/backlinks handles. Synchronous walk;
    // each handle's runLoader is async, but `invalidate` only sets
    // pendingReinvalidate / kicks off a microtask, so the caller's tx
    // resolve isn't blocked on handle re-resolution.
    if (result.snapshots.size > 0) {
      this.handleStore.invalidate(
        snapshotsToChangeNotification(result.snapshots, this.invalidationRules),
      )
    }
    // Step 9 of the §10 pipeline — start field-watch + explicit
    // post-commit processors. Failures are caught + logged inside the
    // runner so a buggy processor can't poison the caller's resolve.
    // Dispatch is intentionally fire-and-forget; callers that need
    // deterministic processor completion can await `awaitProcessors()`.
    void this.processorRunner.dispatch({
      txId: result.txId,
      user: result.user,
      workspaceId: result.workspaceId,
      snapshots: result.snapshots,
      afterCommitJobs: result.afterCommitJobs,
      processors: result.processors,
      propertySchemas: result.propertySchemas,
    })
    return result
  }

  /** Replay an undo / redo entry. Opens a tx in the entry's scope and
   *  raw-applies each (id → snap.before) (undo) or (id → snap.after)
   *  (redo) via the engine-internal `applyRaw` primitive. Replays do
   *  NOT push themselves onto the undo stack — the caller manages
   *  stack motion (manager.pushRedo / manager.pushUndo) so the same
   *  entry shuttles symmetrically between stacks. */
  private async _replay(
    entry: UndoEntry,
    direction: 'before' | 'after',
  ): Promise<void> {
    const action = direction === 'before' ? 'undo' : 'redo'
    const description = entry.description
      ? `${action}: ${entry.description}`
      : action
    await this._runAndDispatch(async (tx) => {
      const txImpl = tx as TxImpl
      for (const [id, snap] of entry.snapshots) {
        await txImpl.applyRaw(id, snap[direction])
      }
    }, {scope: entry.scope, description}, true)
  }

  /** Dynamic dispatch — used by runtime-loaded plugins where the
   *  TypeScript identity isn't available. `name` is the full mutator
   *  name (e.g. `'tasks:setDueDate'` or `'core.indent'`). Args are
   *  validated at the boundary via the mutator's argsSchema. */
  async run<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchMutator(name)(args) as Promise<R>
  }

  /** Dynamic query dispatch — `repo.query[name]` for runtime-loaded
   *  plugins. Resolves the query, runs `.load()`, and returns the
   *  result. The same `core.${name}` shortcut as the proxy applies. */
  async runQuery<R = unknown>(name: string, args: unknown): Promise<R> {
    return this.dispatchQuery(name)(args).load() as Promise<R>
  }

  private resolveTypedBlockQuery(query: TypedBlockQuery): ResolvedTypedBlockQuery {
    return normalizeTypedBlockQuery({
      workspaceId: query.workspaceId,
      types: query.types,
      where: query.where,
      referencedBy: query.referencedBy,
      match: query.match,
      exclude: query.exclude,
      order: query.order,
    })
  }

  /** Run a typed block query once. `workspaceId` is required: callers
   *  that want the user's currently-active workspace use
   *  `queryActiveWorkspace` instead — making the workspace explicit at
   *  the call site prevents background flows / import runs from silently
   *  mis-scoping on a workspace switch (PR #47 review). */
  async queryBlocks(query: TypedBlockQuery): Promise<BlockData[]> {
    return this.query.typedBlocks(this.resolveTypedBlockQuery(query)).load()
  }

  /** Subscribe to a typed block query. `workspaceId` is required: callers
   *  that want the user's currently-active workspace use
   *  `subscribeActiveWorkspace` instead. */
  subscribeBlocks(
    query: TypedBlockQuery,
    listener: (rows: BlockData[]) => void,
    options?: {
      /** Projector-only mode: suppress cached delivery and emit exactly one
       * fresh initial snapshot before forwarding later live changes. */
      freshInitial?: boolean
      onInitialError?: (error: unknown) => void
    },
  ): Unsubscribe {
    const handle = this.query.typedBlocks(this.resolveTypedBlockQuery(query))
    if (options?.freshInitial) {
      let initialPending = true
      const unsubscribe = handle.subscribe(rows => {
        if (!initialPending) listener(rows)
      })
      // Bounded retry: a transient initial-load fault must not settle projector
      // readiness as failed for the whole generation (which would wedge every
      // active-workspace transaction until the next re-pin). Only a persistent
      // failure reaches onInitialError.
      const cancelLoad = runFreshInitialLoad(
        () => handle.loadFresh(),
        rows => {
          initialPending = false
          try {
            listener(rows)
          } catch (error) {
            options.onInitialError?.(error)
          }
        },
        error => {
          initialPending = false
          options.onInitialError?.(error)
        },
      )
      return () => {
        cancelLoad()
        unsubscribe()
      }
    }
    const current = handle.peek()
    if (current !== undefined) queueMicrotask(() => listener(current))
    return handle.subscribe(listener)
  }

  /** Active-workspace shorthand for `queryBlocks`. Resolves
   *  `activeWorkspaceId` at call time; if no workspace is active,
   *  returns an empty list (mirrors the historical fallback behaviour
   *  for the rare callers that legitimately want "whatever the user is
   *  looking at right now"). Most non-UI code should NOT use this —
   *  prefer the bare `queryBlocks` with an explicit workspaceId. */
  async queryActiveWorkspace(
    query: Omit<TypedBlockQuery, 'workspaceId'>,
  ): Promise<BlockData[]> {
    const workspaceId = this.activeWorkspaceId
    if (!workspaceId) return []
    return this.queryBlocks({...query, workspaceId})
  }

  /** Active-workspace shorthand for `subscribeBlocks`. Same caveat as
   *  `queryActiveWorkspace`: the workspace is captured at subscription
   *  time and does NOT re-resolve on later workspace switches. UI
   *  surfaces that need switch-following behaviour should resubscribe
   *  themselves when `activeWorkspaceId` changes (e.g. via
   *  `useActiveWorkspaceId`). */
  subscribeActiveWorkspace(
    query: Omit<TypedBlockQuery, 'workspaceId'>,
    listener: (rows: BlockData[]) => void,
  ): Unsubscribe {
    const workspaceId = this.activeWorkspaceId
    if (!workspaceId) {
      queueMicrotask(() => listener([]))
      return () => {}
    }
    return this.subscribeBlocks({...query, workspaceId}, listener)
  }

  /** Count non-deleted blocks in `workspaceId` whose `properties` map
   *  has a value at `name`. Used by the property-schema editor to warn
   *  the user before deleting a schema definition that's still in use.
   *  Workspace defaults to the active one; missing workspace returns 0. */
  async countBlocksUsingProperty(
    name: string,
    workspaceId?: string,
  ): Promise<number> {
    const wsId = workspaceId ?? this.activeWorkspaceId
    if (!wsId) return 0
    const row = await this.db.getOptional<{count: number}>(
      `
        SELECT COUNT(*) AS count
        FROM blocks b
        WHERE b.workspace_id = ?
          AND b.deleted = 0
          AND json_extract(b.properties_json, ?) IS NOT NULL
      `,
      [wsId, jsonPathForProperty(name)],
    )
    return row?.count ?? 0
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
  get facetRuntime(): FacetRuntime | null {
    return this.facetBridge.facetRuntime
  }

  /** Update the data-layer registries from a FacetRuntime (spec §8) via
   *  the facet bridge. The bridge decomposes the swap into named rebuild
   *  steps that write back into this Repo's registries, preserving the
   *  replay → rebuild → listeners ordering. Kernel mutators must be
   *  present in the runtime if the caller wants them — pass them in via
   *  the static-facet bundle the kernel ships. */
  setFacetRuntime(runtime: FacetRuntime): void {
    this.facetBridge.setFacetRuntime(runtime)
    if (this._activeWorkspaceId) {
      try {
        this.projectors.pinWorkspace(this._activeWorkspaceId)
      } catch (error) {
        // A changed descriptor set can fail both its incoming start and the
        // attempted restoration under this same replacement runtime. Keep the
        // Repo/filter pin honest with the projector runtime so an explicit
        // workspace retry is not suppressed.
        const restoredWorkspaceId = this.projectors.workspaceId
        this._activeWorkspaceId = restoredWorkspaceId
        this.facetBridge.setActiveWorkspaceId(restoredWorkspaceId)
        throw error
      }
    }
  }

  /** Replace the runtime contribution bucket for `facet` keyed by
   *  `sourceId`. Triggers a re-run of every rebuild step whose declared
   *  inputs include this facet, plus per-facet listener fan-out for React
   *  subscribers (e.g. usePropertySchemas). Throws if no FacetRuntime has
   *  been installed yet — callers must setFacetRuntime first.
   *
   *  OWNERSHIP CONTRACT: the bucket is DURABLE — it survives `setFacetRuntime`
   *  swaps via `FacetRuntime.adoptDurableContributionsFrom`, and the Repo is a
   *  per-user singleton reused across workspace switches. Workspace-scoped
   *  buckets are filtered synchronously by the Repo pin, so they cannot bleed
   *  into another workspace. Their owner still clears the captured workspace's
   *  bucket on teardown to bound retained/adopted state and ensure a later
   *  restart rebuilds from the current rows. */
  setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: string,
    contributions: readonly Input[],
    options?: WorkspaceRuntimeContributionOptions,
  ): void {
    this.facetBridge.setRuntimeContributions(facet, sourceId, contributions, options)
  }

  /** Subscribe to changes on `_propertySchemas`. Fires when
   *  `setFacetRuntime` rebuilds the schema map AND when
   *  `setRuntimeContributions(propertySchemasFacet, ...)` updates the
   *  user-data bucket. Used by `usePropertySchemas` so React rerenders
   *  on user-schema add/edit/remove without a runtime swap. */
  onPropertySchemasChange(listener: () => void): () => void {
    return this.facetBridge.onPropertySchemasChange(listener)
  }

  /** Subscribe to changes on `_types`. Fires whenever the rebuild step
   *  that owns `_types` re-runs — i.e. after `setFacetRuntime` AND
   *  after `setRuntimeContributions(typesFacet, ...)` publishes into
   *  the user-data bucket. Symmetric to `onPropertySchemasChange`.
   *  Consumers (e.g. `createTypeBlock` waiting for `UserTypesService`
   *  to publish a freshly-committed type-definition block) recheck
   *  `repo.types` inside the listener; spurious firings are tolerated. */
  onTypesChange(listener: () => void): () => void {
    return this.facetBridge.onTypesChange(listener)
  }

  /** Subscribe to changes on the merged `propertyEditorOverrides` map
   *  (currently driven exclusively by `propertyEditorOverridesFacet`,
   *  but exposed as a Repo-level event so future runtime-contribution
   *  paths layer on without changing the consumer surface). */
  onPropertyEditorOverridesChange(listener: () => void): () => void {
    return this.facetBridge.onPropertyEditorOverridesChange(listener)
  }

  /** Subscribe to changes on the value-preset map. */
  onValuePresetsChange(listener: () => void): () => void {
    return this.facetBridge.onValuePresetsChange(listener)
  }

  /** Subscribe to user-surfaceable errors thrown from `repo.tx`
   *  (currently `ProcessorRejection` from same-tx processors). The
   *  data layer fires; the UI layer (e.g. toast) listens. Returns an
   *  unsubscribe fn. Listener exception isolation is handled by
   *  `CallbackSet.notify` — one bad listener can't poison the others
   *  or break the underlying `repo.tx` error propagation. */
  onUserError(listener: (error: ProcessorRejection) => void): () => void {
    return this.userErrorListeners.add(listener)
  }

  /** Translate a parsed alias-collision RAISE into a fully-populated
   *  `ProcessorRejection`. Runs after the user tx has already rolled
   *  back, so `block_aliases` is back to the pre-tx state — the
   *  conflicting claimant is still indexed and one PK lookup away. */
  private async buildAliasCollisionRejection(
    collision: ParsedAliasCollision,
  ): Promise<ProcessorRejection> {
    const claimantRow = await this.db.getOptional<BlockRow>(
      SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,
      [collision.workspaceId, collision.alias, collision.attemptedBlockId],
    )
    // The claimant should always be present (the trigger only fired
    // because one existed at INSERT time, and the user tx rolled back
    // without touching it). Defensive fallback uses the bare info
    // from the RAISE message if the lookup somehow misses.
    const claimant = claimantRow === null ? null : parseBlockRow(claimantRow)
    // If the attempting block was CREATED in the rejected tx, the
    // rollback erased it — there is no row at all (a tombstone would
    // still be a row). Mark these `collisionOrigin: 'create'` so the
    // toast doesn't offer a "Merge into …" whose source no longer
    // exists.
    const attemptedRow = await this.db.getOptional<{id: string}>(
      'SELECT id FROM blocks WHERE id = ?', [collision.attemptedBlockId],
    )
    return new ProcessorRejection(
      `Alias "${collision.alias}" is already used by another block`,
      'alias.collision',
      {
        alias: collision.alias,
        conflictingBlockId: claimant?.id ?? null,
        // 80-char truncation matches the prior in-processor format —
        // toast UI doesn't render long strings well.
        conflictingBlockTitle: claimant?.content.slice(0, 80) ?? '',
        workspaceId: collision.workspaceId,
        attemptedOn: collision.attemptedBlockId,
        ...(attemptedRow === null ? {collisionOrigin: 'create'} : {}),
      },
    )
  }

  snapshotTypeRegistries(): TypeRegistrySnapshot {
    return {types: this._types, propertySchemas: this._propertySchemas}
  }

  private async reprojectRefTypedProperties(
    propertyNames: readonly string[],
    propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
    /** Workspace to scan + mark. Reprojection is scoped to a single
     *  workspace: `propertySchemas` only reflects the *active* workspace's
     *  user-data schemas, so evaluating ref-ness against another workspace's
     *  blocks is meaningless and would rewrite (or strip) refs in workspaces
     *  the user hasn't even opened. Markers are likewise per-workspace, so each
     *  workspace gets its own one-time backfill when first opened. */
    workspaceId: string,
  ): Promise<void> {
    if (this.isReadOnly || propertyNames.length === 0 || !workspaceId) return
    const t0 = performance.now()
    let blocksUpdated = 0
    let scanScheduled = false
    try {
      // Live registry *as of the gate decision* — workspace-correct (the live
      // map only while still on this scan's workspace, else the scheduled
      // snapshot, so a cross-workspace switch can't decide ref-ness for the
      // captured workspace's blocks). Used only to tell "absent everywhere"
      // from a present redefine in the gate below. The per-block projection
      // later takes a *fresh* `liveSchemas` snapshot (after the SELECT), so it
      // still reconciles against a redefine that lands while the scan is in
      // flight (see the `does not let an older … reprojection re-add` test).
      const liveSchemasAtGate = this._activeWorkspaceId === workspaceId
        ? this._propertySchemas
        : propertySchemas

      // Decide, per name, whether to scan it:
      //  - still ref-typed AND already backfilled here ⇒ SKIP. The references
      //    processor has maintained `references_json` incrementally since the
      //    marker landed, so a re-scan is pure overhead.
      //  - absent from BOTH the scheduled snapshot and the live registry ⇒ SKIP
      //    and RETAIN its existing refs. Absence is "not loaded / toggled off",
      //    NOT "deleted": it occurs when async user/import schemas
      //    (UserSchemasService) republish their bucket as rows materialize,
      //    when a non-essential plugin is toggled off, and when ?safeMode forces
      //    every non-essential off at once. Stripping on absence is what
      //    silently deleted ~10k `next-review-date` backlinks fleet-wide when
      //    SRS was toggled off. (bd7c363a re-enabled that strip believing that,
      //    after workspace-scoping, absence ⟺ a genuine redefine/delete — but it
      //    reasoned only about grow-only cold-start materialization and
      //    cross-workspace switches, never the toggle/safeMode re-resolve that
      //    removes a plugin's schema without deleting anything.)
      //  - PRESENT but non-ref ⇒ scanned, but reprojection is ADD-ONLY (see the
      //    per-block loop), so this is a no-op: there is nothing new to project.
      //    A real ref→non-ref redefine's now-stale derived refs are swept lazily
      //    by the references processor on each block's next write, not here.
      // Reprojection therefore never strips derived refs. Removal is always
      // value-driven (the per-block processor recomputes a field when its value
      // changes) or an explicit delete — never a side-effect of a schema going
      // absent or non-ref. Far cheaper than the mass silent delete that an
      // eager strip risked.
      const markers = await this.reprojectionMarkers.load()
      const namesToScan: string[] = []
      let skippedByMarker = 0
      let skippedByAbsence = 0
      for (const name of propertyNames) {
        const kind = refCodecKind(propertySchemas.get(name))
        if (kind !== undefined && markers.has(reprojectionMarkerKey(workspaceId, name))) {
          skippedByMarker += 1
          continue
        }
        if (!propertySchemas.has(name) && !liveSchemasAtGate.has(name)) {
          skippedByAbsence += 1
          continue
        }
        namesToScan.push(name)
      }
      this.reprojectionMetrics.skippedByMarker += skippedByMarker
      this.reprojectionMetrics.skippedByAbsence += skippedByAbsence
      if (namesToScan.length === 0) return
      scanScheduled = true
      this.reprojectionMetrics.calls += 1
      this.reprojectionMetrics.schemasReprojected += namesToScan.length

      const placeholders = namesToScan.map(() => '?').join(', ')
      const rows = await this.db.getAll<BlockRow>(
        `
          SELECT DISTINCT ${buildQualifiedBlockColumnsSql('b')}
          FROM blocks b, json_each(b.properties_json) prop
          WHERE b.deleted = 0
            AND b.workspace_id = ?
            AND prop.key IN (${placeholders})
        `,
        [workspaceId, ...namesToScan],
      )
      this.reprojectionMetrics.rowsScanned += rows.length
      // Note: we do NOT bail when `this._propertySchemas !== propertySchemas`.
      // On cold start `AppRuntimeProvider` calls `setFacetRuntime` twice
      // (kernel+static, then async with dynamic extensions); a same-context
      // reload calls it once (only the async swap — the sync base commit is
      // gated to cold starts). On cold start that follow-up setFacetRuntime
      // lands while reprojection-1 is mid-SELECT, so bailing here meant
      // reprojection-1 never wrote markers and the same 1.4 s scan repeated
      // on every reload; on a single-swap reload there's no racing follow-up
      // to bail against anyway. Dynamic extensions are additive
      // (no codec redefinitions), so reprojection-1's snapshot is still
      // correct against the current state; per-block tx.get reads live
      // references and the JSON.stringify diff skips writes when nothing
      // changed. If a real codec redefinition ever races a reprojection,
      // the rebuild step's follow-up reprojection corrects it.
      // Even when `rows.length === 0` we still want to record the
      // markers below so the next cold start short-circuits — for many
      // plugin-contributed ref schemas there's simply no legacy data,
      // and we should stamp them as "caught up" the first time.

      // Fresh live snapshot for the per-block projection — re-read here (after
      // the SELECT) rather than reusing `liveSchemasAtGate`, so a redefine that
      // landed while the scan was in flight is reconciled. Project against the
      // live registry only while still on the scan's workspace; after a
      // workspace switch fall back to the scheduled snapshot so the other
      // workspace's schema set can't decide ref-ness for the captured
      // workspace's blocks.
      const liveSchemas = this._activeWorkspaceId === workspaceId
        ? this._propertySchemas
        : propertySchemas

      const blocksByWorkspace = new Map<string, BlockData[]>()
      for (const row of rows) {
        const block = parseBlockRow(row)
        const blocks = blocksByWorkspace.get(block.workspaceId) ?? []
        blocks.push(block)
        blocksByWorkspace.set(block.workspaceId, blocks)
      }

      for (const blocks of blocksByWorkspace.values()) {
        await this.tx(async tx => {
          for (const block of blocks) {
            const liveBlock = await tx.get(block.id)
            if (liveBlock === null || liveBlock.deleted) continue
            // Add-only / retain-on-source contract
            // (docs/contracts/derived-data-add-only.md): reprojection NEVER
            // strips. It fires on a schema change while block *values* are
            // static, so recompute can only ADD — a still-ref field projects
            // exactly its existing refs (no-op), a newly-ref field gains refs,
            // and a now-non-ref / absent field keeps its existing refs
            // (projection adds nothing). `reconcileDerived`'s default retain-all
            // enforces that: all removal is lazy and value-driven — the
            // per-block references processor recomputes a field on the next
            // write to its value — never a side effect of a schema going absent
            // (plugin toggled off, ?safeMode) or non-ref here.
            const projected = namesToScan.flatMap(name =>
              projectedRefsForField(
                liveBlock,
                latestRefProjectionSchema(propertySchemas, liveSchemas, name),
                name,
              )
            )
            const reconciled = reconcileDerived({
              prior: liveBlock.references,
              recomputed: projected,
              keyOf: derivedRefKey,
            })
            if (devAssertionsEnabled()) {
              // L2 dev/test-only assertion (off in prod): reprojection
              // must be ADD-ONLY — prior ⊆ reconciled. A dropped ref here is the
              // mass-strip regression 21494fdb fixed; fail it in CI, never on a
              // user's write. (The length-equality skip below also assumes this
              // superset, so this guards that optimization too.)
              const nextKeys = new Set(reconciled.map(derivedRefKey))
              for (const ref of liveBlock.references) {
                if (!nextKeys.has(derivedRefKey(ref))) {
                  throw new Error(
                    `[reprojection] add-only violated: block ${liveBlock.id} dropped ref ${ref.sourceField ?? ''}/${ref.id}`,
                  )
                }
              }
            }
            // Retain-all add-only ⇒ reconciled ⊇ prior, so an equal length means
            // nothing new was projected. Skip the no-op write (avoids re-firing
            // the field-watcher / write amplification).
            if (reconciled.length === liveBlock.references.length) continue
            await tx.update(liveBlock.id, {references: reconciled}, {skipMetadata: true})
            blocksUpdated += 1
          }
        }, {
          scope: ChangeScope.References,
          description: 'reproject ref-typed properties after schema swap',
        })
      }

      // Record markers for names that are now ref-typed; clear markers
      // for names that have transitioned to non-ref (cleanup case) so a
      // future re-add as ref triggers a fresh scan. Doing this after
      // the per-workspace tx loop means a partial failure leaves some
      // names un-marked → next start retries them, which is the
      // conservative behavior we want.
      for (const name of namesToScan) {
        const schema = latestRefProjectionSchema(propertySchemas, liveSchemas, name)
        const kind = refCodecKind(schema)
        if (kind === undefined) {
          await this.reprojectionMarkers.clear(reprojectionMarkerKey(workspaceId, name))
        } else {
          await this.reprojectionMarkers.set(reprojectionMarkerKey(workspaceId, name))
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[setFacetRuntime] ref-typed property reprojection failed: ${reason}`)
    } finally {
      this.reprojectionMetrics.blocksUpdated += blocksUpdated
      if (scanScheduled) this.reprojectionMetrics.msTotal += performance.now() - t0
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
  private scheduleReprojection(
    names: readonly string[],
    schemas: ReadonlyMap<string, AnyPropertySchema>,
  ): void {
    // Capture the active workspace now, not inside the deferred callback: a
    // workspace switch during the idle-callback window must not re-scope a scan
    // scheduled for the workspace whose schemas actually changed. No active
    // workspace (bootstrap, before any workspace opens) ⇒ nothing to scope, so
    // there's nothing to backfill yet — skip.
    const workspaceId = this._activeWorkspaceId
    if (!workspaceId) return
    this.reprojectionJobs.schedule(() =>
      this.reprojectRefTypedProperties(names, schemas, workspaceId),
    )
  }

  /** Test escape hatch — drop the in-memory marker mirror so the next
   *  reprojection re-reads from `client_schema_state`. Used by tests
   *  that mutate the table out-of-band to simulate cross-session state. */
  __resetReprojectionMarkerCache(): void {
    this.reprojectionMarkers.reset()
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
  async ensureSystemPages(workspaceId: string): Promise<void> {
    if (!workspaceId) return
    const pages = this.facetRuntime?.read(systemPagesFacet) ?? []
    await Promise.all(pages.map(page => page.ensure(this, workspaceId)))
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
  scheduleWorkspaceBackfills(workspaceId: string): void {
    if (this.isReadOnly || !workspaceId || this._workspaceBackfills.length === 0) return
    const backfills = this._workspaceBackfills
    this.workspaceBackfillJobs.schedule(() =>
      this.runWorkspaceBackfills(workspaceId, backfills),
    )
  }

  private async runWorkspaceBackfills(
    workspaceId: string,
    backfills: readonly WorkspaceBackfill[],
  ): Promise<void> {
    const markers = await this.workspaceBackfillMarkers.load()
    for (const backfill of backfills) {
      // A role flip to read-only during the deferral window must stop further
      // writes — re-check per backfill (the loop can span several txs).
      if (this.isReadOnly) return
      if (markers.has(workspaceBackfillMarkerKey(workspaceId, backfill.id))) continue
      const ctx: WorkspaceBackfillContext = {
        workspaceId,
        getAll: <T>(sql: string, params?: readonly unknown[]) =>
          this.db.getAll<T>(sql, params as unknown[] | undefined),
        tx: <R>(fn: (tx: Tx) => Promise<R>, opts: {scope: ChangeScope; description?: string}) =>
          this.tx(fn, opts),
      }
      try {
        await backfill.run(ctx)
        // Record the marker only after a clean run — a thrown backfill leaves
        // it unset so the next open retries (backfills are written idempotent
        // via a per-row recheck, so a retry is cheap).
        await this.workspaceBackfillMarkers.set(workspaceBackfillMarkerKey(workspaceId, backfill.id))
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err)
        console.error(
          `[workspaceBackfills] "${backfill.id}" failed for workspace ${workspaceId}: ${reason}`,
        )
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
  scheduleReconcileRescan(workspaceId: string): void {
    if (!workspaceId) return
    this.reconcileRescanJobs.schedule(() => this.runReconcileRescan(workspaceId))
  }

  private async runReconcileRescan(workspaceId: string): Promise<void> {
    const key = `${RECONCILE_RESCAN_MARKER_PREFIX}${workspaceId}`
    const done = await this.db.getOptional<{key: string}>(SELECT_RECONCILE_RESCAN_MARKER_SQL, [key])
    if (done) return
    try {
      await this.drainSyncWorkspace(workspaceId)
      // Marker only after a clean pass — a thrown/interrupted re-scan leaves it
      // unset so the next open retries (drainSyncWorkspace is resumable + idempotent).
      await this.db.execute(RECORD_RECONCILE_RESCAN_MARKER_SQL, [key])
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      console.error(`[reconcileRescan] workspace ${workspaceId} failed (will retry next open): ${reason}`)
    }
  }

  /** Test helper — drains reconcile-rescans whose deferral timer has fired.
   *  Mirror of `awaitWorkspaceBackfills`. */
  async awaitReconcileRescans(): Promise<void> {
    await this.reconcileRescanJobs.drain()
  }

  /** Strict: throws `BlockNotFoundForTypeError` if `blockId` is missing
   *  or tombstoned at write time. Use when the caller's correctness
   *  depends on the tag actually landing (orchestration / fan-out
   *  paths). For the lenient variant that silently no-ops on a missing
   *  block, see `addTypeInTxLenient` and (in-tx) the dedicated lenient
   *  entry points. Delegates to `TypeTagger` (audit D1(b)). */
  async addType(
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    await this.typeTagger.addType(blockId, typeId, initialValues)
  }

  /** Strict in-tx variant. Throws `BlockNotFoundForTypeError` if the
   *  target block is missing or tombstoned. The default for orchestration
   *  code; pair with the lenient variant only when racing a concurrent
   *  delete is legitimate (sync-apply / processor paths). */
  async addTypeInTx(
    tx: Tx,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
    snapshot?: TypeRegistrySnapshot,
  ): Promise<void> {
    await this.typeTagger.addTypeInTx(tx, blockId, typeId, initialValues, snapshot)
  }

  /** Lenient in-tx variant — silently no-ops if the target block is
   *  missing or tombstoned. Reserved for sync-apply / processor paths
   *  that may legitimately observe a concurrent delete between
   *  pre-tx state and tx-start. New orchestration code should prefer
   *  `addTypeInTx` (strict) so a footgun like the Roam-isa adoption
   *  bug (PR #47) can't be expressed. */
  async addTypeInTxLenient(
    tx: Tx,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
    snapshot?: TypeRegistrySnapshot,
  ): Promise<void> {
    await this.typeTagger.addTypeInTxLenient(tx, blockId, typeId, initialValues, snapshot)
  }

  async removeType(blockId: string, typeId: string): Promise<void> {
    await this.typeTagger.removeType(blockId, typeId)
  }

  async removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
    await this.typeTagger.removeTypeInTx(tx, blockId, typeId)
  }

  async toggleType(blockId: string, typeId: string): Promise<void> {
    await this.typeTagger.toggleType(blockId, typeId)
  }

  async setBlockTypes(blockId: string, typeIds: readonly string[]): Promise<void> {
    await this.typeTagger.setBlockTypes(blockId, typeIds)
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
  private swapQueries(newQueries: Map<string, AnyQuery>): void {
    let mutated = false
    for (const [name, newQ] of newQueries) {
      const old = this.queries.get(name)
      if (old !== undefined) {
        if (old !== newQ) { mutated = true; break } // REPLACE
      } else if (!name.startsWith('core.') && newQueries.has(`core.${name}`)) {
        mutated = true; break // shadowing ADD (see doc above)
      }
      // plain ADD (no shadow) is additive-safe → no bump.
    }
    // A REMOVED name (present before, gone now).
    if (!mutated) {
      for (const oldName of this.queries.keys()) {
        if (!newQueries.has(oldName)) { mutated = true; break }
      }
    }
    this.queries = newQueries
    if (mutated) this.queryEpoch++
  }

  /** Wait until the post-commit processor framework has nothing
   *  pending — useful in tests + scripted scenarios that need
   *  deterministic ordering after a `repo.tx` resolves. Does NOT
   *  advance timers; jobs scheduled with `delayMs` only enter the
   *  pending set when the timer fires. */
  async awaitProcessors(): Promise<void> {
    await this.processorRunner.awaitIdle()
  }

  /** Wait until every reprojection whose deferral timer has already
   *  fired has finished writing. Like `awaitProcessors()`, this does
   *  NOT advance timers — a reprojection only enters the pending set
   *  once its `setTimeout`/`requestIdleCallback` callback runs, so
   *  callers using fake timers must advance the clock first. Loops so
   *  that a reprojection settling while we await an earlier one is
   *  still drained. Reprojection runs never schedule further
   *  reprojections, so this terminates. */
  async awaitReprojections(): Promise<void> {
    await this.reprojectionJobs.drain()
  }

  /** Wait until every workspace backfill whose deferral timer has already
   *  fired has finished. Mirror of `awaitReprojections` — does NOT advance
   *  timers; fake-timer callers must advance the clock first. */
  async awaitWorkspaceBackfills(): Promise<void> {
    await this.workspaceBackfillJobs.drain()
  }

  /** Test-only escape hatch retained for stage-level tests that wire
   *  specific processor sets without a FacetRuntime. */
  __setProcessorsForTesting(processors: ReadonlyArray<AnyPostCommitProcessor>): void {
    this.processors = new Map(processors.map(p => [p.name, p]))
  }

  /** Test-only mirror of `__setProcessorsForTesting` for same-tx
   *  processors. Used by stage-level tests that need to exercise
   *  the in-tx runner without going through the facet runtime. */
  __setSameTxProcessorsForTesting(processors: ReadonlyArray<AnySameTxProcessor>): void {
    this.sameTxProcessors = new Map(processors.map(p => [p.name, p]))
  }

  /** Build the dispatcher closure for a mutator name. Resolution order:
   *    1. literal `name` (kernel full-name like `'core.indent'`,
   *       plugin full-name like `'tasks:setDueDate'`)
   *    2. `'core.${name}'` (so `repo.mutate.indent` resolves to
   *       `'core.indent'` even though the registry key is full-prefixed)
   *  Throws `MutatorNotRegisteredError` if neither matches.
   *  `groupId` (from an `undoGroup` facade) stamps the dispatched tx so
   *  it merges into the group's undo entry. */
  private dispatchMutator(name: string, groupId?: string): (args: unknown) => Promise<unknown> {
    return async (args: unknown) => {
      const m = this.mutators.get(name) ?? this.mutators.get(`core.${name}`)
      if (!m) throw new MutatorNotRegisteredError(name)
      const validated = m.argsSchema.parse(args) as never
      const scope = typeof m.scope === 'function' ? m.scope(validated) : m.scope
      return this.tx(tx => tx.run(m, validated) as Promise<unknown>, {
        scope,
        description: m.describe?.(validated),
        groupId,
      })
    }
  }

  /** Test-only escape hatch retained for stage 1.3 carryover tests
   *  that wired specific mutator sets without a FacetRuntime. New
   *  tests should prefer `setFacetRuntime` (or `installKernelRuntime:
   *  false` plus `setFacetRuntime`). */
  __setMutatorsForTesting(mutators: ReadonlyArray<AnyMutator>): void {
    this.mutators = new Map(mutators.map(m => [m.name, m]))
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
  private makeQueryCtx(
    dataSink: ResolveContext,
    registry: ReadonlyMap<string, AnyQuery>,
    depth: number,
  ): QueryCtx {
    return {
      db: this.db,
      repo: this,
      hydrateBlocks: (rows, opts) => this.hydrateRows(
        rows as unknown as ReadonlyArray<BlockRow>,
        {ctx: dataSink, declareRowDeps: opts?.declareRowDeps ?? true},
      ),
      depend: (dep) => dataSink.depend(dep),
      run: ((name: string, args: unknown, opts?: {deps?: 'inherit' | 'none'}) =>
        this.runSubquery(
          name, args, dataSink, registry, opts?.deps ?? 'inherit', depth,
        )) as QueryCtx['run'],
    }
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
  private async runSubquery(
    name: string,
    args: unknown,
    parentDataSink: ResolveContext,
    registry: ReadonlyMap<string, AnyQuery>,
    deps: 'inherit' | 'none',
    parentDepth: number,
  ): Promise<unknown> {
    const depth = parentDepth + 1
    if (depth > MAX_QUERY_COMPOSITION_DEPTH) {
      throw new Error(
        `QueryCtx.run: composition depth exceeded ${MAX_QUERY_COMPOSITION_DEPTH} ` +
        `resolving '${name}' (likely a query composition cycle)`,
      )
    }
    const q = registry.get(name) ?? registry.get(`core.${name}`)
    if (!q) throw new QueryNotRegisteredError(name)
    const childDataSink: ResolveContext = deps === 'none' ? {depend: () => {}} : parentDataSink
    const validated = q.argsSchema.parse(args) as never
    const raw = await q.resolve(
      validated, this.makeQueryCtx(childDataSink, registry, depth),
    )
    return q.resultSchema.parse(raw)
  }

  /** Build the dispatcher closure for a query name. Same resolution
   *  order as `dispatchMutator`: literal name first, then
   *  `'core.${name}'`. The returned closure validates args via the
   *  query's `argsSchema`, then `getOrCreate`s an identity-stable
   *  `LoaderHandle` keyed by `(queryName, args)`. The loader wraps the
   *  query's `resolve` with a `QueryCtx` that forwards `depend` to the
   *  handle's `ResolveContext` and exposes `db` / `repo` /
   *  `hydrateBlocks`. */
  private dispatchQuery(name: string): (args: unknown) => LoaderHandle<unknown> {
    return (args: unknown) => {
      // Capture the registry snapshot for this handle. The loader (and
      // every `ctx.run` beneath it) resolves against THIS map, so the
      // handle stays pinned to a consistent query-version snapshot even
      // after a later swap replaces `this.queries`. getOrCreate only runs
      // the factory on first create, so an existing handle keeps the
      // registry captured at ITS creation — re-keying via the bumped epoch
      // is what binds the next lookup to a new snapshot.
      const registry = this.queries
      const q = registry.get(name) ?? registry.get(`core.${name}`)
      if (!q) throw new QueryNotRegisteredError(name)
      const validated = q.argsSchema.parse(args) as never
      // Use the registry-stored full name in the key so the bare-name
      // shortcut (`repo.query.subtree`) and the literal full-name access
      // (`repo.query['core.subtree']`) hit the same handle slot.
      const fullName = q.name
      // Folding the global epoch into the key means any registry swap
      // produces a distinct handle slot for the NEXT lookup of every
      // query — old handles keep serving their captured snapshot and GC
      // once subscribers detach; fresh lookups bind to the new registry.
      const key = handleKey(`query:${fullName}@${this.queryEpoch}`, validated)
      return this.handleStore.getOrCreate(key, () => new LoaderHandle({
        store: this.handleStore,
        key,
        loader: async (ctx) => {
          // Time the resolve for `repo.metrics().queries[fullName]`.
          // Counts cold loads + every re-resolve from invalidate; that
          // matches "ms to settle" — the unit a debug panel cares
          // about. argsSchema.parse and resultSchema.parse run inside
          // the timed window because they're part of the dispatch
          // path's wall-clock cost.
          const t0 = performance.now()
          try {
            const raw = await q.resolve(validated, this.makeQueryCtx(ctx, registry, 0))
            // Result-schema parse at the boundary — symmetry with argsSchema
            // and the documented contract (Query.resultSchema is required).
            // For loose kernel schemas (`z.array(z.unknown())`) this is a
            // pass-through; for strict plugin schemas it's the safety net
            // that prevents a malformed resolver from publishing to the
            // handle's subscribers + Suspense throwers.
            return q.resultSchema.parse(raw)
          } finally {
            this.queryMetrics.record(fullName, performance.now() - t0)
          }
        },
      }))
    }
  }

  /** Test-only escape hatch parallel to `__setMutatorsForTesting`.
   *  Bypasses the FacetRuntime so unit tests can register a single
   *  query without standing up a full kernel runtime. Routes through
   *  `swapQueries` so generation bookkeeping stays consistent with
   *  the production `setFacetRuntime` path. */
  __setQueriesForTesting(queries: ReadonlyArray<AnyQuery>): void {
    this.swapQueries(new Map(queries.map(q => [q.name, q])))
  }
}

// Re-import ChangeScope so the file's TypeScript module structure
// includes a use of it (used inside dispatchMutator's scope-resolve
// path indirectly through Mutator.scope; explicit import keeps the
// dependency visible to readers).
void ChangeScope
