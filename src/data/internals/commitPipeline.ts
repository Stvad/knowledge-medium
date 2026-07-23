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
  BlockData,
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
): ChangedRow[] => {
  if (processor.watches.kind !== 'field') return []
  if (processor.watches.table !== 'blocks') return []
  const out: ChangedRow[] = []
  for (const [id, entry] of snapshots) {
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

/** Field paths one recorded write touched: `properties.<key>` per
 *  changed bag key, the field name for every other changed field. Same
 *  JSON-equality semantics as `sameTxFieldChanged`, but per WRITE (this
 *  write's before/after from the `onWrite` hook), not per tx — the
 *  settled-write baseline needs to know which paths each individual
 *  write moved so a settled amendment and a later unsettled write to
 *  the same row stay distinguishable. */
const changedWritePaths = (
  before: BlockData | null,
  after: BlockData | null,
): string[] => {
  const paths: string[] = []
  const fields = new Set([
    ...Object.keys(before ?? {}),
    ...Object.keys(after ?? {}),
  ])
  fields.delete('properties')
  const b = before as unknown as Record<string, unknown> | null
  const a = after as unknown as Record<string, unknown> | null
  for (const field of fields) {
    const x = b?.[field]
    const y = a?.[field]
    if (x === y ? false : JSON.stringify(x) !== JSON.stringify(y)) paths.push(field)
  }
  const beforeBag = before?.properties ?? {}
  const afterBag = after?.properties ?? {}
  for (const key of new Set([...Object.keys(beforeBag), ...Object.keys(afterBag)])) {
    const x = beforeBag[key]
    const y = afterBag[key]
    if (x === y ? false : JSON.stringify(x) !== JSON.stringify(y)) {
      paths.push(`properties.${key}`)
    }
  }
  return paths
}

const jsonEq = (a: unknown, b: unknown): boolean =>
  a === b ? true : JSON.stringify(a) === JSON.stringify(b)

/** The re-run pass's `before` for one row. Built so a field path diffs
 *  against the net `after` iff it changed since TX START **or** since
 *  the processor's WATERMARK — and never when its last writer was a
 *  `settledWrites` processor. Two baselines because each alone hides a
 *  real case (both found on PR #428):
 *   - tx-start alone: a later processor restoring a field to its
 *     tx-start value after the derivation ran on the intermediate value
 *     nets to zero — invisible to an apply that diffs field content
 *     internally (MATERIALIZE's changed-name computation), leaving
 *     value children synced to the intermediate bag.
 *   - watermark alone: a write the processor's own gates SKIPPED in
 *     pass one (a bag written on a then-field-row that DERIVE later
 *     un-stamps) is part of the watermark state, so it never diffs and
 *     the re-run does nothing with it.
 *  Settled-last paths read as their final values on top of the merge —
 *  a settled amendment is baseline, never delta (see the
 *  `settledFieldPaths` declaration for the laundering failure).
 *  `txStart === null` (row inserted this tx) passes through as null:
 *  every path already diffs maximally against a null before, and the
 *  destructive misread the settled mask exists to stop (a settled
 *  key-UNSET diffing as a user deletion) is unrepresentable there. */
const rerunBefore = (
  txStart: BlockData | null,
  atWatermark: BlockData | null,
  after: BlockData | null,
  settled: ReadonlySet<string> | undefined,
): BlockData | null => {
  if (txStart === null || after === null) return txStart
  if (atWatermark === null) return txStart
  const merged = {...atWatermark, properties: {...atWatermark.properties}}
  const m = merged as unknown as Record<string, unknown>
  const ts = txStart as unknown as Record<string, unknown>
  const af = after as unknown as Record<string, unknown>
  const fields = new Set([
    ...Object.keys(txStart), ...Object.keys(atWatermark), ...Object.keys(after),
  ])
  fields.delete('properties')
  for (const field of fields) {
    if (settled?.has(field)) {
      m[field] = af[field]
      continue
    }
    if (jsonEq(m[field], af[field]) && !jsonEq(ts[field], af[field])) {
      m[field] = ts[field]
    }
  }
  const hasOwn = (bag: Record<string, unknown>, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(bag, key)
  const keys = new Set([
    ...Object.keys(txStart.properties),
    ...Object.keys(atWatermark.properties),
    ...Object.keys(after.properties),
  ])
  for (const key of keys) {
    const inAfter = hasOwn(after.properties, key)
    if (settled?.has(`properties.${key}`)) {
      if (inAfter) merged.properties[key] = after.properties[key]
      else delete merged.properties[key]
      continue
    }
    const wmEqAfter = hasOwn(merged.properties, key) === inAfter
      && jsonEq(merged.properties[key], after.properties[key])
    const tsEqAfter = hasOwn(txStart.properties, key) === inAfter
      && jsonEq(txStart.properties[key], after.properties[key])
    if (wmEqAfter && !tsEqAfter) {
      if (hasOwn(txStart.properties, key)) {
        merged.properties[key] = txStart.properties[key]
      } else {
        delete merged.properties[key]
      }
    }
  }
  return merged
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
  // Second half of the settled-write channel: per row, the field paths
  // (`properties.<key>` for bag keys, a top-level field name otherwise)
  // whose LAST writer was a settled processor. Suppressing dirtiness
  // alone is not enough — once any UNSETTLED writer dirties the same
  // row, the re-run's tx-start→net diff would surface the settled
  // amendments as if they were user intent (adversarial review on PR
  // #428: PROJECT's deliberate cell unset plus an alias.sync write to
  // the same owner made the re-run MATERIALIZE read the unset as a user
  // key-deletion and tombstone a live field row and its user-edited
  // value child). The re-run pass therefore masks settled-last paths
  // out of each eligible row's `before` (before := net after for that
  // path), so a settled amendment is baseline, never delta. Unsettled
  // writes UN-mark exactly the paths they touch — last writer wins,
  // matching the strictly sequential processor order, which is what
  // keeps a genuine unsettled re-key (merge retarget moving a cell
  // between definition keys) fully visible to the re-run.
  const settledFieldPaths = new Map<string, Set<string>>()
  // Per-row write log (every write, settled or not, with the generation
  // current AFTER that write): lets the re-run pass reconstruct a row's
  // state AS OF a processor's watermark. The re-run's `before` must be
  // "what this processor last saw", not the tx-start state — a later
  // processor can restore a field to its tx-start value after the
  // derivation ran on the intermediate value, and a tx-start baseline
  // makes that restore invisible to an apply that diffs field content
  // internally (MATERIALIZE's changedPropertyNames — Codex review on PR
  // #428: pass two fired on the dirty row but computed no changed names,
  // leaving value children synced to the intermediate bag). Entries hold
  // references to the same `after` objects the primitives built — no
  // copying.
  const rowWriteLog = new Map<string, Array<{gen: number, after: BlockData | null}>>()
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
      onWrite: (id, before, after) => {
        if (settleWrites) {
          let paths = settledFieldPaths.get(id)
          if (paths === undefined) settledFieldPaths.set(id, paths = new Set())
          for (const path of changedWritePaths(before, after)) paths.add(path)
        } else {
          rowWriteGens.set(id, ++writeGen)
          const paths = settledFieldPaths.get(id)
          if (paths !== undefined) {
            for (const path of changedWritePaths(before, after)) paths.delete(path)
          }
        }
        // Log EVERY write (settled ones under the unbumped generation:
        // they fold into "state as of" whatever watermark covers that
        // generation, which is exactly their declared-baseline intent).
        let log = rowWriteLog.get(id)
        if (log === undefined) rowWriteLog.set(id, log = [])
        log.push({gen: writeGen, after})
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
          if (collectMs >= 1) {
            timing.sameTxProcessorRuns.push(
              {name: processor.name, changedRows: 0, collectMs, applyMs: 0},
            )
          }
        } else {
          await applyProcessor(processor, changedRows, emittedEvents, collectMs)
        }
        // Watermark recorded after EVERY slot — fired or skipped — so
        // pass two's "dirtied since it ran" reads the same point in the
        // sequence either way.
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
      // `settledWrites` processors (the rename re-key, PROJECT's cell
      // writes) never mark rows dirty, AND their field paths are masked
      // out of the re-run diff below (`maskSettledPaths`) — dirtiness
      // suppression alone leaks the moment an unsettled co-writer
      // dirties the same row (see the `settledFieldPaths` declaration
      // for the laundering failure this closes).
      // Dispatch on DIRTINESS, not on the net tx field diff: a later
      // writer can revert a watched field to its tx-start value after a
      // derivation ran on the intermediate value (net diff empty, derived
      // state stale — Codex review on PR #428), so any post-watermark
      // write makes the row eligible. `before` is the tx-start state
      // (same event shape as pass one) except for settled-last field
      // paths, which read as their net-after values; rows whose watched
      // fields are truly untouched no-op inside the idempotent
      // processors.
      for (const processor of sameTxProcessors.values()) {
        if (processor.rerunOnDirtyRows !== true) continue
        // Field-watch on the blocks table only. defineSameTxProcessor
        // enforces field-kind at definition time (nothing enforces the
        // table — today the watch type only admits 'blocks'); both
        // checks backstop hand-built literals, mirroring
        // collectSameTxFieldMatches.
        if (processor.watches.kind !== 'field') continue
        if (processor.watches.table !== 'blocks') continue
        const watermark = watermarks.get(processor.name) ?? 0
        const collectStartedAt = performance.now()
        const changedRows: ChangedRow[] = []
        for (const [id, gen] of rowWriteGens) {
          if (gen <= watermark) continue
          const entry = snapshots.get(id)
          if (!entry) continue
          // Reconstruct the row as of THIS processor's watermark (last
          // logged write at gen ≤ watermark; tx-start when every write
          // came later), then merge with tx-start into the two-baseline
          // re-run `before` — see `rerunBefore` for why either baseline
          // alone hides a real case.
          let atWatermark = entry.before
          const log = rowWriteLog.get(id)
          if (log !== undefined) {
            for (const record of log) {
              if (record.gen > watermark) break
              atWatermark = record.after
            }
          }
          const before = rerunBefore(
            entry.before, atWatermark, entry.after, settledFieldPaths.get(id),
          )
          changedRows.push({id, before, after: entry.after})
        }
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
