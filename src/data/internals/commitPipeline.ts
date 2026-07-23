/**
 * Commit pipeline (§10): drives a `repo.tx` invocation end-to-end.
 *
 *   1. Validate scope vs. read-only mode.
 *   2. Open `db.writeTransaction(fn)`.
 *      a. Set `tx_context` (tx_id, user_id, scope, source).
 *      b. Construct TxImpl + snapshots map.
 *      c. Run user fn (primitives write through to SQL inline).
 *      d. INSERT command_events row.
 *      e. Clear `tx_context` (all four → NULL).
 *   3. On COMMIT (post-fn-resolve, before promise resolves):
 *      a. Walk snapshots map: update cache to `after` per id (or evict
 *         on hard-delete).
 *      b. (Future) record undo entry.
 *      c. Resolve repo.tx promise with user fn's return.
 *   4. Post-resolve: dispatch afterCommit jobs (their own
 *      writeTransactions). (Stage 1.3: jobs collected only; the
 *      processor framework that actually fires them lands in 1.5.)
 *
 * Failure modes:
 *   - User fn throws → SQLite rolls back the writeTransaction. Snapshots
 *     map is discarded. **Cache was never mutated**, so there's nothing
 *     to revert; outside-tx readers saw the pre-tx state throughout.
 *     afterCommit jobs are discarded — they only fire on commit (§5.3).
 *   - DB error inside the writeTransaction → same rollback path.
 */

import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnyPropertySchema,
  AnySameTxProcessor,
  ChangedRow,
  RepoTxOptions,
  SameTxEmittedEvent,
  Tx,
  User,
} from '@/data/api'
import {
  ReadOnlyError,
  scopeAllowedInReadOnly,
  scopeUploadsToServer,
  sourceForScope,
} from '@/data/api'
import {
  assertNoSeedDefinitionWrites,
  newTxMeta,
  TxImpl,
  type AfterCommitJob,
  type MutatorCallRecord,
  type TxDb,
} from './txEngine'
import { newSnapshotsMap, type SnapshotsMap } from './txSnapshots'
import { propertySchemaResolverForWorkspace } from './propertySchemaResolution'
import type { BlockCache } from '@/data/blockCache'
import type {PropertyDefinitionRegistrySnapshot} from '@/data/propertyDefinitionRegistry'

/** Minimal subset of the full PowerSync DB our pipeline + Repo talks
 *  to. The test harness (`createTestDb`) returns a real
 *  `PowerSyncDatabase` that satisfies this; production passes the
 *  same. Both `writeTransaction` (for tx primitives) and the read
 *  surface (`getAll` / `getOptional` / `get` for `repo.load`) are
 *  needed. `onChange` is the table-change subscription used by
 *  reactive query hooks until the row_events tail in Phase 2 ships a
 *  typed invalidation surface. */
export interface PowerSyncDbChangeHandler {
  onChange: () => void | Promise<void>
  onError?: (error: unknown) => void
}

export interface PowerSyncDbChangeOptions {
  tables?: readonly string[]
  throttleMs?: number
}

export interface PowerSyncDb {
  writeTransaction<R>(fn: (tx: TxDb) => Promise<R>): Promise<R>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  get<T>(sql: string, params?: unknown[]): Promise<T>
  /** Execute an arbitrary SQL statement (no result rows). Used by the
   *  agent runtime bridge for `mode='execute'` SQL. Avoid in
   *  application code — every write should go through `repo.tx`. */
  execute(sql: string, params?: unknown[]): Promise<unknown>
  onChange(
    handler: PowerSyncDbChangeHandler,
    options?: PowerSyncDbChangeOptions,
  ): () => void
  /** Release the underlying connection (OPFS sync access handle on
   *  web, file handle in node). Used by `exportSqliteDb` when
   *  swapping the live .db file out from under the worker. */
  close(): Promise<void>
}

/** Compute the changedRows passed to a same-tx processor for the
 *  current snapshot state. Mirrors the post-commit
 *  `collectFieldMatches` in `processorRunner.ts` but lives here so
 *  the same-tx pass doesn't have to import from `processorRunner`
 *  (which has its own React/Repo dependency baggage). Recomputed
 *  per-processor inside the runner so later processors see
 *  amendments by earlier ones in the same pass. */
const collectSameTxFieldMatches = (
  processor: AnySameTxProcessor,
  snapshots: SnapshotsMap,
  /** Derivation re-run pass (issue #402): restrict the collect to rows
   *  written after the processor's first run. `before` stays the tx-start
   *  state — same shape as pass one, so idempotent processors see an
   *  already-handled change again and no-op on it. */
  onlyIds?: ReadonlySet<string>,
): ChangedRow[] => {
  if (processor.watches.kind !== 'field') return []
  if (processor.watches.table !== 'blocks') return []
  const out: ChangedRow[] = []
  for (const [id, entry] of snapshots) {
    if (onlyIds !== undefined && !onlyIds.has(id)) continue
    if (processor.watches.fields.some(f => sameTxFieldChanged(entry.before, entry.after, f as string))) {
      out.push({id, before: entry.before, after: entry.after})
    }
  }
  return out
}

const collectSameTxEventMatches = (
  processor: AnySameTxProcessor,
  sameTxEvents: readonly SameTxEmittedEvent[],
): SameTxEmittedEvent[] => {
  if (processor.watches.kind !== 'event') return []
  const names = new Set(processor.watches.events)
  return sameTxEvents.filter(event => names.has(event.name))
}

/** Mirror of `processorRunner.fieldChanged`. Duplicated rather than
 *  shared because `processorRunner.ts` depends on Repo + React
 *  surfaces this file deliberately doesn't pull in. */
const sameTxFieldChanged = (
  before: ChangedRow['before'],
  after: ChangedRow['after'],
  field: string,
): boolean => {
  if (before === null) return after !== null
  if (after === null) return true
  const a = (before as unknown as Record<string, unknown>)[field]
  const b = (after as unknown as Record<string, unknown>)[field]
  return a === b ? false : JSON.stringify(a) !== JSON.stringify(b)
}

/** Per-same-tx-processor timing sample for one tx (PR #288 §12: the
 *  property-children processors add write amplification at parents —
 *  this is the counter that watches it). Collected only for processors
 *  that matched rows (or whose collect scan itself cost ≥1ms). */
export interface SameTxProcessorTiming {
  readonly name: string
  readonly changedRows: number
  readonly collectMs: number
  readonly applyMs: number
}

export interface TxTimingDiagnostics {
  sameTxMs: number
  sameTxChangedRows: number
  sameTxProcessorRuns: SameTxProcessorTiming[]
}

export interface RunTxParams<R> {
  db: PowerSyncDb
  cache: BlockCache
  fn: (tx: Tx) => Promise<R>
  opts: RepoTxOptions
  user: User
  isReadOnly: boolean
  newTxId: () => string
  /** Monotonically increasing INTEGER per `repo.tx`. Written into
   *  `tx_context.tx_seq` so the upload-routing triggers can stamp
   *  `ps_crud.tx_id` and PowerSync's `getNextCrudTransaction()` groups
   *  multi-row writes correctly. Required to be strictly increasing
   *  across calls within a single `Repo`; the default Repo provider
   *  uses a counter seeded from `Date.now()`. */
  newTxSeq: () => number
  newId: () => string
  now: () => number
  mutators: ReadonlyMap<string, AnyMutator>
  /** Processor registry snapshot, captured at tx start. Used by
   *  `tx.afterCommit` to validate scheduledArgs at enqueue time. */
  processors: ReadonlyMap<string, AnyPostCommitProcessor>
  /** Same-tx processor registry snapshot, captured at tx start. The
   *  runner walks this in registration order between `fn` returning
   *  and the `command_events` insert, inside the writeTransaction.
   *  Throws (e.g. `ProcessorRejection`) propagate out and roll back
   *  the user's tx atomically. */
  sameTxProcessors: ReadonlyMap<string, AnySameTxProcessor>
  /** When true this tx is an undo/redo replay driven by
   *  `TxImpl.applyRaw` (see `Repo._replay`). The same-tx processor
   *  pass is SKIPPED for replays: `applyRaw` is contracted to drive
   *  each row to EXACTLY the restored snapshot (§10 step 7, the
   *  `applyRaw` doc in `txEngine.ts`), but its write is still a field
   *  change in the replay tx — so a value-deriving same-tx processor
   *  (e.g. one that appends to `content`) would re-fire and override
   *  the restore, leaving the row at a derived value rather than the
   *  state being restored to. Post-commit processors are unaffected;
   *  they dispatch from `_runAndDispatch` regardless. Default false. */
  isReplay?: boolean
  /** Merged property-schema registry snapshot, captured at the same
   *  boundary as `processors` so processor code sees a consistent
   *  runtime bundle. */
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>
  /** Tx-start-captured workspace registry factory. It reads no live runtime
   * state when the target row's workspace becomes known inside the tx. */
  propertyDefinitionRegistryForWorkspace: (
    workspaceId: string,
  ) => PropertyDefinitionRegistrySnapshot | null
  /** Active workspace captured with the registry factory at tx start. */
  propertySchemaWorkspaceId: string | null
  /** Original declaration-name multiplicity paired with the runtime snapshot. */
  propertySeedNameCounts: ReadonlyMap<string, number>
}

export interface TxResult<R> {
  /** User fn's return value (resolved synchronously after commit walk). */
  value: R
  /** afterCommit jobs scheduled by the tx — to be dispatched by the
   *  caller (Repo) after the tx promise resolves. Empty if rollback. */
  afterCommitJobs: AfterCommitJob[]
  /** Snapshots map for the committed tx — used by the post-commit
   *  processor framework to compute field-watch matches. Empty map if
   *  the user fn made no writes. */
  snapshots: SnapshotsMap
  /** Pinned workspace at commit time. `null` for zero-write txs;
   *  CommittedEvent contracts on this being a string when present, so
   *  the runner skips field-watch + explicit dispatch entirely when
   *  null (no work to do anyway — no field changed, and afterCommit
   *  threw WorkspaceNotPinnedError if called pre-write). */
  workspaceId: string | null
  /** Tx id (for processor CommittedEvent.txId). */
  txId: string
  /** User who ran the tx (for processor CommittedEvent.user). */
  user: User
  /** Processor registry snapshot taken at tx start. The runner walks
   *  this (not its current registry) so a `setFacetRuntime` call that
   *  lands while a tx is in flight can't remove or replace processors
   *  before that tx's field-watch / explicit jobs fire — the spec says
   *  registries are snapshotted at tx start (§3, §8). */
  processors: ReadonlyMap<string, AnyPostCommitProcessor>
  /** Merged property-schema registry snapshot paired with `processors`. */
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>
  /** Same-tx step timings for diagnostics (write-amplification watch —
   *  PR #288 §12). Internal callers attribute slow writeTransactions
   *  without changing tx semantics. */
  timing: Readonly<TxTimingDiagnostics>
}

export const runTx = async <R>(params: RunTxParams<R>): Promise<TxResult<R>> => {
  const {
    db, cache, fn, opts, user, isReadOnly,
    newTxId, newTxSeq, newId, now,
    mutators, processors, sameTxProcessors, propertySchemas,
    propertyDefinitionRegistryForWorkspace,
    propertySchemaWorkspaceId,
    propertySeedNameCounts,
    isReplay = false,
  } = params
  const {scope, description} = opts

  // §10.3 read-only gate. UiState and UserPrefs writes are allowed even
  // in read-only mode; they queue normally and any server-side rejection
  // (RLS / FK) lands in the upload-rejection quarantine.
  if (isReadOnly && !scopeAllowedInReadOnly(scope)) {
    throw new ReadOnlyError(scope)
  }

  const txId = newTxId()
  const txSeq = newTxSeq()
  const source = sourceForScope(scope)
  const snapshots: SnapshotsMap = newSnapshotsMap()
  // Derivation-liveness bookkeeping (issue #402): a monotonically
  // increasing write generation per recorded row write, and the latest
  // generation per row. The same-tx pass records a per-processor
  // watermark after its slot; the re-run pass visits only rows whose
  // generation exceeds a processor's watermark — i.e. rows some LATER
  // writer dirtied after that processor already ran. Writes made while
  // a `settledWrites` processor is applying are the explicit-intent
  // channel: declared convergent/final, they never mark rows dirty.
  const rowWriteGens = new Map<string, number>()
  let writeGen = 0
  let settleWrites = false
  const afterCommitJobs: AfterCommitJob[] = []
  const sameTxEvents: SameTxEmittedEvent[] = []
  // `tx.run` pushes onto this list each time a mutator runs (including
  // the outer call from `repo.mutate.X` / `repo.run` since those open
  // the tx with `fn = tx => tx.run(m, args)`). Pipeline serializes
  // the list at commit time into command_events.mutator_calls.
  const mutatorCalls: MutatorCallRecord[] = []
  const meta = newTxMeta({txId, scope, source, user, description})
  const timing: TxTimingDiagnostics = {
    sameTxMs: 0,
    sameTxChangedRows: 0,
    sameTxProcessorRuns: [],
  }
  // Workspace-bound schema-name resolution for same-tx processors — the same
  // tx-start-captured identity primitive TxImpl resolves through (its private
  // `propertySchemaResolverFor` delegates to this very closure, passed into
  // TxImplContext below), built once here so both surfaces see one registry
  // snapshot per tx.
  const resolverFor = (workspaceId: string) =>
    propertySchemaResolverForWorkspace(
      propertyDefinitionRegistryForWorkspace(workspaceId),
      workspaceId,
      propertySeedNameCounts,
      propertySchemaWorkspaceId === null || workspaceId === propertySchemaWorkspaceId,
    )
  const resolvePropertySchemaName = (workspaceId: string, name: string) =>
    resolverFor(workspaceId).resolve(name)
  const resolvePropertySchemaField = (workspaceId: string, fieldId: string) =>
    resolverFor(workspaceId).resolveField(fieldId)

  // Run inside writeTransaction. Steps 1-5 commit or roll back atomically.
  const value = await db.writeTransaction(async (txDb): Promise<R> => {
    // Step 1: set tx_context — triggers read this for source-tagging
    // row_events + gating upload routing + gating workspace-invariant
    // checks (§4.1.1, §4.3, §4.5). tx_seq is the integer key the
    // upload triggers stamp into ps_crud.tx_id so PowerSync's
    // getNextCrudTransaction() groups multi-row writes correctly.
    await txDb.execute(
      `UPDATE tx_context SET tx_id = ?, tx_seq = ?, user_id = ?, scope = ?, source = ?, group_id = ? WHERE id = 1`,
      [txId, txSeq, user.id, scope, source, opts.groupId ?? null],
    )

    // Step 2: construct Tx + snapshots map + run user fn.
    const tx = new TxImpl({
      txDb,
      snapshots,
      cache,
      meta,
      afterCommitJobs,
      mutatorCalls,
      mutators,
      processors,
      propertySchemaResolverFor: resolverFor,
      sameTxEvents,
      now,
      newId,
      onWrite: (id) => {
        if (!settleWrites) rowWriteGens.set(id, ++writeGen)
      },
    })
    // Important: any tx.run calls in the user fn push onto
    // `mutatorCalls` after the dispatch wrapper's initial entry. We
    // capture the running list (mutating closure) rather than passing
    // a snapshot so the command_events row written in step 4 reflects
    // every mutator the tx actually ran.
    const result = await fn(tx)

    // Step 3.5: same-tx processor pass. Runs after `fn` returns but
    // before the command_events insert — inside the writeTransaction,
    // so throws (e.g. ProcessorRejection) propagate to SQLite's abort
    // and roll back the whole tx atomically.
    //
    // Iteration order: registration order from the facet snapshot.
    // Each processor's changedRows is recomputed from the live
    // `snapshots` map before its apply runs, so a later processor
    // sees an earlier processor's amendments. Single pass — no
    // fixpoint; if two processors fight, that's a registration-order
    // bug, not infinite-loop-able.
    //
    // Only the snapshot taken at tx start (`sameTxProcessors`) is
    // iterated — mid-tx facet swaps don't affect the running tx,
    // matching the §3/§8 contract.
    //
    // Replay txs (undo/redo) skip this pass entirely (`isReplay`):
    // `applyRaw` drives each row to EXACTLY the restored snapshot, so
    // re-deriving here would override the restore. See the `isReplay`
    // doc on RunTxParams.
    if (!isReplay && sameTxProcessors.size > 0 && (snapshots.size > 0 || sameTxEvents.length > 0)) {
      const sameTxStartedAt = performance.now()
      const applyProcessor = async (
        processor: AnySameTxProcessor,
        changedRows: ChangedRow[],
        emittedEvents: SameTxEmittedEvent[],
        collectMs: number,
      ): Promise<void> => {
        // workspaceId is guaranteed here: field matches require a
        // snapshot-producing write, and tx.emitEvent refuses to run
        // before the tx has pinned a workspace.
        if (meta.workspaceId === null) {
          throw new Error('same-tx processor matched without a pinned workspace')
        }
        const applyStartedAt = performance.now()
        settleWrites = processor.settledWrites === true
        try {
          await processor.apply(
            {
              txId,
              scope,
              user,
              workspaceId: meta.workspaceId,
              changedRows,
              emittedEvents,
            },
            {
              tx, db: txDb, propertySchemas,
              resolvePropertySchemaName, resolvePropertySchemaField,
            },
          )
        } finally {
          settleWrites = false
        }
        timing.sameTxChangedRows += changedRows.length
        timing.sameTxProcessorRuns.push({
          name: processor.name,
          changedRows: changedRows.length,
          collectMs,
          applyMs: performance.now() - applyStartedAt,
        })
      }

      // Pass one: the single pass, registration order (kernel processors
      // precede plugin ones). Each processor's watermark is recorded
      // AFTER its slot, so its own writes never re-trigger it and only
      // LATER writers count as "dirtied since it ran".
      const watermarks = new Map<string, number>()
      for (const processor of sameTxProcessors.values()) {
        const collectStartedAt = performance.now()
        const changedRows = collectSameTxFieldMatches(processor, snapshots)
        const collectMs = performance.now() - collectStartedAt
        const emittedEvents = collectSameTxEventMatches(processor, sameTxEvents)
        if (changedRows.length === 0 && emittedEvents.length === 0) {
          watermarks.set(processor.name, writeGen)
          if (collectMs >= 1) {
            timing.sameTxProcessorRuns.push(
              {name: processor.name, changedRows: 0, collectMs, applyMs: 0},
            )
          }
          continue
        }
        await applyProcessor(processor, changedRows, emittedEvents, collectMs)
        watermarks.set(processor.name, writeGen)
      }

      // Pass two — the derivation-liveness re-run (issue #402). A
      // derivation that ran early in the pass can have its INPUT
      // rewritten by a later processor in the same tx (a plugin content
      // rewrite after PROJECT, a raw properties write after MATERIALIZE,
      // a kernel stamp after MATERIALIZE's ancestry read) — leaving the
      // derived state describing pre-rewrite content. Rather than
      // hand-patching each such cell (three ad-hoc idioms existed, and
      // three consecutive reviews each found a matrix cell the audits
      // missed), re-run the opted-in derivation processors over just the
      // rows written after their first run.
      //
      // Bounded at ONE re-run — no fixpoint, per the single-pass
      // contract. Convergence rests on the opted-in processors'
      // idempotence (§5 invariant 1): a residual write left by a
      // pass-two processor for an EARLIER pass-two processor is by
      // construction already convergent (MATERIALIZE/PROJECT are mutual
      // inverses whose round-trip no-ops; DERIVE/NORMALIZE re-derive to
      // the same value), so a third pass would no-op. Writes from
      // `settledWrites` processors (the rename re-key) never mark rows
      // dirty, which is what keeps the stale-registry MATERIALIZE
      // misread out of this pass entirely.
      for (const processor of sameTxProcessors.values()) {
        if (processor.rerunOnDirtyRows !== true) continue
        const watermark = watermarks.get(processor.name) ?? 0
        const collectStartedAt = performance.now()
        const dirtyIds = new Set<string>()
        for (const [id, gen] of rowWriteGens) {
          if (gen > watermark) dirtyIds.add(id)
        }
        const changedRows = dirtyIds.size === 0
          ? []
          : collectSameTxFieldMatches(processor, snapshots, dirtyIds)
        const collectMs = performance.now() - collectStartedAt
        if (changedRows.length === 0) continue
        await applyProcessor(processor, changedRows, [], collectMs)
      }
      timing.sameTxMs = performance.now() - sameTxStartedAt
    }

    // Step 3.6: seed-definition write guard — one choke point over
    // everything this tx (user fn + same-tx processors) wrote, still
    // inside the writeTransaction so a violation rolls the whole tx
    // back atomically. Replays are exempt like the same-tx pass, but not
    // because guarded txs can't touch seed rows — a guarded BlockDefault
    // tx CAN legally produce an undo entry for a valid seed row (e.g. a
    // content/references edit), and that entry's `applyRaw` snapshot
    // captures the row's full state including its properties bag.
    // Replaying it restores that snapshot verbatim, which can transiently
    // regress a code-owned bag (e.g. undoing an edit recorded before a
    // revision-upgrade re-materialization). Accepted because
    // materialization self-heals the bag on its next pass, and blocking
    // replays outright would break undo atomicity.
    if (!isReplay) assertNoSeedDefinitionWrites(snapshots, scope)

    // Step 4: write command_events row — one per repo.tx invocation
    // (per §4.4). workspace_id is the pinned value (or NULL on
    // zero-write txs). source is uniformly 'user' for every repo.tx
    // invocation; sync-applied writes don't go through repo.tx.
    await txDb.execute(
      `INSERT INTO command_events
        (tx_id, description, scope, user_id, workspace_id, mutator_calls, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        txId,
        description ?? null,
        scope,
        user.id,
        meta.workspaceId,
        // mutatorCalls is mutated in place during the user fn (each
        // tx.run pushes a record). Serialized at commit time so audit
        // sees every mutator this tx invoked. Raw `repo.tx(fn, opts)`
        // calls with no tx.run produce '[]' — same as zero-write txs.
        JSON.stringify(mutatorCalls),
        source,
        now(),
      ],
    )

    // Step 5: clear tx_context. Doing this inside the writeTransaction
    // means rollback restores the pre-tx state atomically — no risk of
    // a stale tx_id / tx_seq leaking into a sync-applied row_event or
    // ps_crud row after a crashed local tx (the trigger CASE on
    // `source IS NULL` is the belt-and-suspenders backup for row_events;
    // this clear is the primary).
    await txDb.execute(
      `UPDATE tx_context SET tx_id = NULL, tx_seq = NULL, user_id = NULL, scope = NULL, source = NULL, group_id = NULL WHERE id = 1`,
    )

    return result
  })

  // Step 6: post-COMMIT cache walk. Update cache to `after` per id
  // (deepFrozen by BlockCache.setSnapshot). A hard-delete drives the
  // row to a confirmed-missing marker instead of merely evicting the
  // snapshot so already-loaded Block facades keep observing "absent"
  // rather than regressing to "not loaded". Outside-tx readers begin
  // observing committed state from this point.
  for (const [id, entry] of snapshots) {
    if (entry.after === null) {
      cache.markMissing(id)
    } else {
      cache.setSnapshot(entry.after)
    }
  }

  // Step 9 — return everything Repo needs to dispatch field-watch +
  // explicit processors. Repo wraps this with its ProcessorRunner.
  return {
    value,
    afterCommitJobs,
    snapshots,
    workspaceId: meta.workspaceId,
    txId,
    user,
    processors,
    propertySchemas,
    timing: Object.freeze({
      ...timing,
      sameTxProcessorRuns: timing.sameTxProcessorRuns.slice(),
    }),
  }
}

// Internal export for tests / debug — `scopeUploadsToServer` documents
// which scopes are upload-bound at the engine level (matches the
// upload-routing trigger gate `source = 'user'`).
export const __debug = {scopeUploadsToServer}
