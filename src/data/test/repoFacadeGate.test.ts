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
  facetRuntime: 'getter read',
  propertiesPageId: 'getter read',
  propertyEditorOverrides: 'getter read',
  propertySchemas: 'getter read',
  types: 'getter read',
  typesPageId: 'getter read',
  undoManager: 'getter read (resolves per-workspace manager)',
  valuePresets: 'getter read',
  metrics: 'read-only snapshot of counters',
  exists: 'read',
  countBlocksUsingProperty: 'read',
  snapshotTypeRegistries: 'read — returns existing registry maps, no minting',
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
  reprojectRefTypedProperties: 'private-ish maintenance; invoked by constructor-bound facetBridge',
  resolveTypedBlockQuery: 'private read',
  runReconcileRescan: 'private; jobs are enqueued via the DELEGATED schedule* overrides',
  runSubquery: 'private read',
  runWorkspaceBackfills: 'private; jobs are enqueued via the DELEGATED schedule* overrides',
  scheduleReprojection: 'private; invoked by constructor-bound facetBridge',
  swapQueries: 'private; assigns fields but reached only via setFacetRuntime (constructor-bound)',

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
 *  valued fields are flagged where their binding matters. */
const SAFE_INSTANCE_FIELDS: Record<string, string> = {
  _activeWorkspaceId: 'data field',
  _propertyEditorOverrides: 'data field',
  _propertySchemas: 'data field',
  _types: 'data field',
  _valuePresets: 'data field',
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

    // 1. No unclassified members. A failure here means a Repo member was
    //    added without deciding its facade behavior — classify it per the
    //    rubric in the module doc: override in `groupedFacade`, or add it
    //    to the allowlist with the reviewed reason.
    const unclassifiedProto = protoMembers.filter(
      (name) => !overrides.has(name) && !(name in SAFE_VIA_PROTOTYPE),
    )
    expect(unclassifiedProto, 'new Repo prototype member(s) need a facade classification').toEqual([])
    const unclassifiedFields = instanceFields.filter(
      (name) => !overrides.has(name) && !(name in SAFE_INSTANCE_FIELDS),
    )
    expect(unclassifiedFields, 'new Repo instance field(s) need a facade classification').toEqual([])

    // 2. No stale allowlist entries (member renamed/removed → prune the list).
    const known = new Set([...protoMembers, ...instanceFields])
    const stale = [
      ...Object.keys(SAFE_VIA_PROTOTYPE),
      ...Object.keys(SAFE_INSTANCE_FIELDS),
    ].filter((name) => !known.has(name))
    expect(stale, 'allowlist entries no longer on Repo').toEqual([])

    // 3. Nothing both overridden AND allowlisted (pick one home).
    const doubled = [
      ...Object.keys(SAFE_VIA_PROTOTYPE),
      ...Object.keys(SAFE_INSTANCE_FIELDS),
    ].filter((name) => overrides.has(name))
    expect(doubled, 'members both overridden and allowlisted').toEqual([])

    // 4. Every override shadows a real Repo member (catches renames that
    //    would leave a dead override silently delegating to the prototype).
    const orphaned = [...overrides].filter((name) => !known.has(name))
    expect(orphaned, 'facade overrides with no matching Repo member').toEqual([])
  })
})
