// @vitest-environment node
/**
 * Structural gate for the `repo.undoGroup` facade contract (PR #308
 * follow-up; docs/undo-grouping.md).
 *
 * The facade built by `groupedFacade` delegates everything it does not
 * explicitly override to the real Repo via the prototype chain — which
 * runs those members with the facade as `this`. That is safe only for
 * some member shapes; three hazard classes need an explicit override:
 *
 *   1. shared-state minting — the member stores a `this`-capturing
 *      object/closure into shared or long-lived state (`block` caching
 *      a facade-bound Block forever was the original blocker;
 *      `runQuery` minting a facade-capturing LoaderHandle was its
 *      round-2 sibling; the `schedule*` job enqueuers defer
 *      facade-bound closures past the group's lifetime).
 *   2. instance-field assignment — `this.<field> = x` with the facade
 *      as `this` SHADOWS the write onto the facade; the real repo
 *      never sees it (`setActiveWorkspaceId`, `setReadOnly`, the
 *      sync-observer pair, `undo`/`redo` via metrics bookkeeping).
 *   3. construction-captured collaborators — the member routes writes
 *      through an object that captured the REAL repo at construction
 *      and therefore opens UNGROUPED txs mid-group (the TypeTagger
 *      convenience writes; the stateful userSchemas/userTypes/
 *      projectors services are the documented exception — they can't
 *      be facade-twinned without clobbering shared buckets).
 *
 * Until now that contract lived in a comment ("adding a Repo member in
 * one of these classes means adding a facade override"). This test
 * makes it structural: every member of Repo — prototype methods,
 * getters, and constructor-assigned instance properties — must be
 * EITHER overridden by `groupedFacade` OR consciously classified in
 * the allowlist below. Adding a Repo member without classifying it
 * fails this test; the failure message is the review prompt.
 *
 * HOW TO CLASSIFY a new member (the reviewer rubric):
 *   - Does it assign `this.<field>` (directly or transitively, e.g.
 *     via `_runAndDispatch`'s metrics writes)? → override (delegate to
 *     the real repo) or make it not do that.
 *   - Does it store anything capturing `this` into state that outlives
 *     the call (identity maps, handle stores, job queues, listener
 *     sets holding bound methods)? → override.
 *   - Does it write through a collaborator constructed with the real
 *     repo? → override with a facade-hosted twin (stateless
 *     collaborators only) or document it as group-escaping.
 *   - Otherwise (pure read; mutation of a shared object reached
 *     through the chain; writes into a caller-provided tx) → allowlist
 *     with a short reason.
 *   - 'getter read' requires proving the getter ASSIGNS nothing — a
 *     lazily-initializing getter (`this._x ??= mk(this)`) would shadow
 *     its backing field onto the facade. The gate reads every
 *     non-overridden getter through the facade and fails if any own
 *     property materializes on it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { Repo } from '@/data/repo'

/** Members safe to reach through the prototype chain, each with the
 *  reviewed reason. Keys must exist on Repo (staleness is asserted) and
 *  must NOT also be facade overrides (double-listing is asserted). */
const SAFE_VIA_PROTOTYPE: Record<string, string> = {
  // ── reads (getters / pure lookups) ──
  activeWorkspaceId: 'getter read',
  activeLayoutSessionId: 'getter read',
  facetRuntime: 'getter read',
  propertiesPageId: 'getter read',
  propertyEditorOverrides: 'getter read',
  propertyDefinitions: 'getter read',
  typeDefinitions: 'getter read',
  propertySchemas: 'getter read',
  types: 'getter read',
  typesPageId: 'getter read',
  undoManager: 'getter; delegates to undoManagerFor (see its entry for the mint)',
  valuePresetCores: 'getter read',
  metrics: 'read-only snapshot of counters',
  exists: 'read',
  countBlocksUsingProperty: 'read',
  snapshotTypeRegistries: 'read — returns existing registry maps, no minting',
  propertySchemaResolverFor: 'read — returns a resolver bound to an existing immutable snapshot',
  whenPropertyDefinitionsReady: 'waits on the constructor-bound projector service; assigns no Repo fields',
  load: 'read + shared BlockCache mutation (object-interior, reached via chain)',
  undoManagerFor: 'mints UndoManager into the shared map, but UndoManager captures no repo',

  // ── writes into a caller-provided tx (grouping follows the caller) ──
  addTypeInTx: 'writes into the caller tx',
  addTypeInTxLenient: 'writes into the caller tx',
  removeTypeInTx: 'writes into the caller tx',

  // ── shared-object mutation / subscription via the chain (no this-capture, no field assignment) ──
  awaitProcessors: 'drains a shared job object',
  awaitReconcileRescans: 'drains a shared job object',
  awaitReprojections: 'drains a shared job object',
  awaitSeedMaterialization: 'drains a shared job object',
  awaitPropertyDefinitionMigrations: 'drains a shared job object',
  awaitReferenceTargetDerive: 'drains a shared job object',
  awaitWorkspaceBackfills: 'drains a shared job object',
  drainSyncWorkspace: 'reads this.syncObserver through the chain; never assigns it',
  flushSyncObserver: 'reads this.syncObserver through the chain; never assigns it',
  onUserError: 'adds the caller listener to a shared CallbackSet; no this-capture',
  onPropertyEditorOverridesChange: 'delegates to constructor-bound facetBridge',
  onPropertySchemasChange: 'delegates to constructor-bound facetBridge',
  onTypesChange: 'delegates to constructor-bound facetBridge',
  onValuePresetsChange: 'delegates to constructor-bound facetBridge',
  queryActiveWorkspace: 'routes through the constructor-bound query proxy',
  queryBlocks: 'routes through the constructor-bound query proxy',
  subscribeActiveWorkspace: 'routes through the constructor-bound query proxy',
  subscribeBlocks: 'routes through the constructor-bound query proxy',
  setFacetRuntime: 'facetBridge write-back closures were constructor-bound to the real repo',
  setRuntimeContributions: 'facetBridge write-back closures were constructor-bound to the real repo',

  // ── deliberately grouped-through-the-facade (this.tx resolves to the override) ──
  ensureSystemPages: 'kernel-page ensure txs deliberately JOIN the group (round-3 review)',

  // ── TS-private internals — not part of the facade consumer surface ──
  _replay: 'private (undo/redo internals; reached only via delegated undo/redo)',
  _runAndDispatch: 'private (reached only via overridden tx/undo/redo, this = real repo)',
  buildAliasCollisionRejection: 'private',
  dispatchMutator: 'private (overridden run/mutate pass groupId explicitly)',
  dispatchQuery: 'private',
  groupedFacade: 'private (the facade factory itself)',
  hydrateChildren: 'private read',
  hydrateRows: 'private read + shared-cache mutation',
  makeQueryCtx: 'private (reached via delegated runQuery / real-repo query proxy)',
  propertyDefinitionProjector: 'private read through the constructor-bound projector service',
  reprojectRefTypedProperties: 'private-ish maintenance; invoked by constructor-bound facetBridge',
  resolveTypedBlockQuery: 'private read',
  runReconcileRescan: 'private; jobs are enqueued via the DELEGATED schedule* overrides',
  runWorkspaceSeedMaterialization: 'private; jobs are enqueued via the DELEGATED schedule* overrides',
  materializeSeedKind: 'private; reached only from runWorkspaceSeedMaterialization (delegated schedule* overrides)',
  runSubquery: 'private read',
  runReferenceTargetDerivePass: 'private; jobs are enqueued via the DELEGATED schedule* overrides',
  drainNameRederives: 'private; jobs are enqueued via the facetBridge-bound schedule',
  runWorkspaceBackfills: 'private; jobs are enqueued via the DELEGATED schedule* overrides',
  workspaceSeeds: 'private read; reached only via the DELEGATED schedule/run seed-materialization members',
  scheduleReprojection: 'private; invoked by constructor-bound facetBridge',
  schedulePropertyDefinitionMigrations: 'invoked by constructor-bound facetBridge',
  scheduleReferenceTargetNameRederive: 'invoked by constructor-bound facetBridge',
  stampReferenceTargets: 'private; raw source-NULL writes via schedule-driven jobs',
  referenceTargetLookupsVia: 'private read — builds resolver closures, assigns no fields',
  runPropertyDefinitionMigrations: 'private; jobs are enqueued via the facetBridge-bound schedule',
  runPropertyDefinitionMigrationBatch: 'private; jobs are enqueued via the facetBridge-bound schedule',
  swapQueries: 'private; assigns fields — reached via setFacetRuntime (constructor-bound) and __setQueriesForTesting (see its entry: never call on a facade)',

  // ── test-only escape hatches (assign fields — never call on a facade) ──
  __resetReprojectionMarkerCache: 'test-only',
  __setMutatorsForTesting: 'test-only; assigns fields — do not call on a facade',
  __setProcessorsForTesting: 'test-only; assigns fields — do not call on a facade',
  __setQueriesForTesting: 'test-only; assigns fields — do not call on a facade',
  __setSameTxProcessorsForTesting: 'test-only; assigns fields — do not call on a facade',
}

/** Constructor-assigned instance properties. Reads through the chain
 *  hit the real repo's values; mutating the OBJECTS they hold (maps,
 *  caches, stores) mutates shared state correctly. The hazard —
 *  ASSIGNING one of these through the facade — only arises inside
 *  members, which the prototype classification above covers. Function-
 *  valued fields are flagged where their binding matters.
 *
 *  This inventory is option-independent because every Repo field is a
 *  DECLARED class field (useDefineForClassFields defines them all at
 *  construction, assigned or not). A `declare`-modifier field or an
 *  `(x as any).field =` dynamic write would escape the inventory —
 *  don't introduce either on Repo. */
const SAFE_INSTANCE_FIELDS: Record<string, string> = {
  _activeWorkspaceId: 'data field',
  _activeLayoutSessionId: 'data field',
  _propertyDefinitionRegistry: 'data field',
  _previousPropertyDefinitionRegistry: 'data field',
  _typeDefinitionRegistry: 'data field',
  _propertySeedNameCounts: 'data field',
  _propertyEditorOverrides: 'data field',
  _propertySchemas: 'data field',
  _types: 'data field',
  _valuePresetCores: 'data field',
  _workspaceBackfills: 'data field',
  blockFacades: 'shared identity map (facade never mints into it — `block` override)',
  cache: 'shared object',
  db: 'shared object',
  dbMetrics: 'shared object',
  facetBridge: 'collaborator constructor-bound to the real repo',
  handleStore: 'shared object (facade never mints into it — `runQuery` override)',
  instanceId: 'data field',
  invalidationRules: 'data field',
  isReadOnly: 'data field (writes go through the delegated setReadOnly)',
  mutators: 'data field',
  newId: 'pure generator function (no this)',
  newTxSeq: 'pure generator function (no this)',
  now: 'pure clock function (no this)',
  processorRunner: 'collaborator constructor-bound to the real repo',
  processors: 'data field',
  projectors: 'stateful service constructor-bound to the real repo — documented group-escaping',
  queries: 'data field',
  query: 'dispatch proxy whose closures captured the real repo at construction',
  queryEpoch: 'data field',
  queryMetrics: 'shared object',
  reconcileRescanJobs: 'shared job queue (facade never enqueues — schedule* overrides)',
  reprojectionJobs: 'shared job queue',
  seedMaterializationGeneration: 'data field (AbortController; reassigned only via the delegated setActiveWorkspaceId)',
  pendingSeedMaterializationWorkspaces: 'shared Set (facade never mutates — schedule* overrides)',
  dirtySeedMaterializationWorkspaces: 'shared Set (facade never mutates — schedule* overrides)',
  seedMaterializationJobs: 'shared job queue (facade never enqueues — schedule* overrides)',
  reprojectionMarkers: 'shared object',
  reprojectionMetrics: 'shared object',
  sameTxProcessors: 'data field',
  slowestTx: 'metrics field (writers run with real-repo this via overrides)',
  syncObserver: 'data field (writes go through the delegated observer pair)',
  syncObserverDeps: 'data field',
  txLog: 'shared array (mutated in place, never reassigned outside constructor)',
  typeTagger: 'collaborator constructor-bound to the real repo — facade hosts its own for addType & co.',
  undoManagers: 'shared map (values capture no repo)',
  user: 'data field',
  userErrorListeners: 'shared CallbackSet',
  userSchemas: 'stateful service constructor-bound to the real repo — documented group-escaping',
  userTypes: 'stateful service constructor-bound to the real repo — documented group-escaping',
  workspaceBackfillJobs: 'shared job queue (facade never enqueues — schedule* overrides)',
  workspaceBackfillMarkers: 'shared object',
  referenceTargetDeriveJobs: 'shared job queue (facade never enqueues — schedule* overrides)',
  referenceTargetSweepDone: 'shared Set (session bookkeeping)',
  pendingNameRederives: 'shared Map (session bookkeeping)',
  nameRederiveDrainScheduled: 'shared Set (session bookkeeping)',
  propertyDefinitionMigrationJobs: 'shared job queue (enqueued via constructor-bound facetBridge)',
}

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

describe('undoGroup facade — structural override/allowlist gate', () => {
  it('every Repo member is either facade-overridden or consciously classified', async () => {
    const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'gate-user'}})
    // Capturing the facade outside its callback is exactly what
    // production code must never do — here it IS the subject under test.
    const facade = await repo.undoGroup(async (grouped) => grouped)

    const overrides = new Set(Object.getOwnPropertyNames(facade))
    const protoMembers = Object.getOwnPropertyNames(Repo.prototype)
      .filter((name) => name !== 'constructor')
    const instanceFields = Object.getOwnPropertyNames(repo)
    const allowlisted = [
      ...Object.keys(SAFE_VIA_PROTOTYPE),
      ...Object.keys(SAFE_INSTANCE_FIELDS),
    ]

    // 0a. Enumeration soundness: getOwnPropertyNames skips symbol keys,
    //     so a symbol-keyed member (e.g. a future
    //     `[Symbol.asyncDispose]() { this.stopSyncObserver() }`) would
    //     ship invisible to every check below. Force a gate revision
    //     the moment one appears.
    expect(Object.getOwnPropertySymbols(Repo.prototype),
      'symbol-keyed prototype member — extend this gate to enumerate symbols').toEqual([])
    expect(Object.getOwnPropertySymbols(repo),
      'symbol-keyed instance member — extend this gate to enumerate symbols').toEqual([])
    // 0b. Enumeration soundness: getOwnPropertyNames does not walk the
    //     prototype chain — if Repo ever gains `extends Base`, inherited
    //     members would ship unclassified. Force a gate revision then.
    expect(Object.getPrototypeOf(Repo.prototype),
      'Repo gained a base class — extend this gate to walk the chain').toBe(Object.prototype)

    // 1. No unclassified members. A failure here means a Repo member was
    //    added without deciding its facade behavior — classify it per the
    //    rubric in the module doc: override in `groupedFacade`, or add it
    //    to the allowlist with the reviewed reason.
    const unclassifiedProto = protoMembers.filter(
      (name) => !overrides.has(name) && !(name in SAFE_VIA_PROTOTYPE),
    )
    expect(unclassifiedProto,
      'new Repo prototype member(s) need a facade classification — override in groupedFacade or allowlist per the rubric at the top of this file').toEqual([])
    const unclassifiedFields = instanceFields.filter(
      (name) => !overrides.has(name) && !(name in SAFE_INSTANCE_FIELDS),
    )
    expect(unclassifiedFields,
      'new Repo instance field(s) need a facade classification — override in groupedFacade or allowlist per the rubric at the top of this file').toEqual([])

    // 2. No stale allowlist entries (member renamed/removed → prune),
    //    checked PER SIDE so a member migrating between prototype and
    //    instance (method ⇄ arrow-function class field) drags its
    //    classification along instead of leaving a mis-homed leftover.
    const staleProto = Object.keys(SAFE_VIA_PROTOTYPE)
      .filter((name) => !protoMembers.includes(name))
    expect(staleProto, 'SAFE_VIA_PROTOTYPE entries not on Repo.prototype').toEqual([])
    const staleFields = Object.keys(SAFE_INSTANCE_FIELDS)
      .filter((name) => !instanceFields.includes(name))
    expect(staleFields, 'SAFE_INSTANCE_FIELDS entries not on the instance').toEqual([])

    // 3. Exactly one home per member: never both overridden and
    //    allowlisted, and never classified on both allowlists.
    const doubled = allowlisted.filter((name) => overrides.has(name))
    expect(doubled, 'members both overridden and allowlisted').toEqual([])
    const crossListed = Object.keys(SAFE_VIA_PROTOTYPE)
      .filter((name) => name in SAFE_INSTANCE_FIELDS)
    expect(crossListed, 'members classified on BOTH allowlists').toEqual([])

    // 4. Every override shadows a real Repo member (catches renames that
    //    would leave a dead override silently delegating to the prototype).
    const known = new Set([...protoMembers, ...instanceFields])
    const orphaned = [...overrides].filter((name) => !known.has(name))
    expect(orphaned, 'facade overrides with no matching Repo member').toEqual([])

    // 5. 'getter read' classifications are PROVEN, not trusted: read
    //    every non-overridden getter through the facade; a lazily-
    //    initializing getter (`this._x ??= mk(this)`) would shadow its
    //    backing field onto the facade — a field that never existed at
    //    inventory time and so could never be allowlisted.
    for (const name of protoMembers) {
      const descriptor = Object.getOwnPropertyDescriptor(Repo.prototype, name)
      if (typeof descriptor?.get !== 'function' || overrides.has(name)) continue
      void (facade as unknown as Record<string, unknown>)[name]
    }
    const materialized = Object.getOwnPropertyNames(facade)
      .filter((name) => !overrides.has(name))
    expect(materialized,
      'reading a getter through the facade materialized own properties on it — a lazily-assigning getter is shadowing state').toEqual([])
    // Symbol-keyed backing fields would evade the name check above (and
    // assertion 0a ran before the getter reads); groupedFacade installs
    // only string-keyed overrides, so ANY symbol here is a shadow.
    expect(Object.getOwnPropertySymbols(facade),
      'reading a getter through the facade materialized a symbol-keyed own property on it').toEqual([])
  })
})
