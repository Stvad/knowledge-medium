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
 *   - row_events tail subscription for sync-applied invalidation
 */

import { v4 as uuidv4 } from 'uuid'
import type { FacetRuntime, Facet } from '@/extensions/facet'
import type {
  AnyMutator,
  AnyPostCommitProcessor,
  AnySameTxProcessor,
  AnyPropertyEditorOverride,
  AnyPropertySchema,
  AnyQuery,
  AnyValuePreset,
  BlockData,
  BlockReference,
  Mutator,
  MutatorRegistry,
  Query,
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
  isRefCodec,
  isRefListCodec,
} from '@/data/api'
import { runTx, type PowerSyncDb } from './internals/commitPipeline'
import type { BlockCache } from '@/data/blockCache'
import { buildQualifiedBlockColumnsSql, parseBlockRow, type BlockRow } from '@/data/blockSchema'
import { KERNEL_MUTATORS } from './internals/kernelMutators'
import { KERNEL_PROCESSORS } from './internals/kernelProcessors'
import { KERNEL_SAME_TX_PROCESSORS } from './internals/normalizeReferencesProcessor'
import { KERNEL_QUERIES } from './internals/kernelQueries'
import { kernelInvalidationRule } from './internals/kernelInvalidation'
import {
  invalidationRulesFacet,
  mutatorsFacet,
  postCommitProcessorsFacet,
  sameTxProcessorsFacet,
  propertyEditorOverridesFacet,
  propertySchemasFacet,
  queriesFacet,
  typesFacet,
  valuePresetsFacet,
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
  startRowEventsTail,
  type RowEventsTail,
  type RowEventsTailOptions,
} from './internals/rowEventsTail'
import {
  CLEAR_REPROJECT_REF_MARKER_SQL,
  RECORD_REPROJECT_REF_MARKER_SQL,
  REPROJECT_REF_MARKER_PREFIX,
  SELECT_REPROJECT_REF_MARKERS_SQL,
} from './internals/clientSchema'
import { UndoManager, type UndoEntry } from './internals/undoManager'
import type { TxImpl } from './internals/txEngine'
import { ANCESTORS_SQL, CHILDREN_SQL, SUBTREE_SQL } from './internals/treeQueries'
import {
  SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_EXCLUDING_SQL,
  SELECT_BLOCK_BY_ID_SQL,
} from './internals/kernelQueries'
import type { InvalidationRule } from './invalidation'
import { KERNEL_PROPERTY_SCHEMAS, getBlockTypes, typesProp } from './properties'
import { KERNEL_TYPE_CONTRIBUTIONS } from './blockTypes'
import { propertiesPageBlockId } from './propertiesPage'
import { UserSchemasService } from './userSchemasService'

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

const mergeLiftedSchemas = (
  directSchemas: ReadonlyMap<string, AnyPropertySchema>,
  types: ReadonlyMap<string, TypeContribution>,
): ReadonlyMap<string, AnyPropertySchema> => {
  const merged = new Map<string, AnyPropertySchema>()
  for (const type of types.values()) {
    for (const schema of type.properties ?? []) {
      const existing = merged.get(schema.name)
      if (existing !== undefined && existing !== schema) {
        console.warn(
          `[schema-lift] type "${type.id}" registers schema "${schema.name}" ` +
          'that conflicts with an earlier type-lifted registration; last-wins per facet convention',
        )
      }
      merged.set(schema.name, schema)
    }
  }
  for (const [name, schema] of directSchemas) {
    const existing = merged.get(name)
    if (existing !== undefined && existing !== schema) {
      console.warn(
        `[schema-lift] direct propertySchemasFacet registration "${name}" ` +
        'replaces an earlier type-lifted registration; last-wins per facet convention',
      )
    }
    merged.set(name, schema)
  }
  return merged
}

const KERNEL_TYPES = new Map(KERNEL_TYPE_CONTRIBUTIONS.map(t => [t.id, t]))
const KERNEL_PROPERTY_SCHEMA_MAP = new Map(KERNEL_PROPERTY_SCHEMAS.map(s => [s.name, s]))

/** Bounded ring of recent tx entries surfaced via `repo.metrics().txLog`.
 *  Sized to comfortably cover a cold-start window (a few dozen txs) so
 *  diagnostic dumps right after page load don't lose entries. */
const TX_LOG_CAPACITY = 64

type RefCodecKind = 'ref' | 'refList' | undefined

const refCodecKind = (schema: AnyPropertySchema | undefined): RefCodecKind => {
  if (schema === undefined) return undefined
  if (isRefCodec(schema.codec)) return 'ref'
  if (isRefListCodec(schema.codec)) return 'refList'
  return undefined
}

const changedRefSchemaNames = (
  before: ReadonlyMap<string, AnyPropertySchema>,
  after: ReadonlyMap<string, AnyPropertySchema>,
): string[] => {
  const names = new Set([...before.keys(), ...after.keys()])
  return Array.from(names)
    .filter(name => refCodecKind(before.get(name)) !== refCodecKind(after.get(name)))
    .sort()
}

const appendRefProjection = (
  refs: BlockReference[],
  seen: Set<string>,
  sourceField: string,
  id: string,
): void => {
  const targetId = id.trim()
  if (!targetId) return
  const key = `${sourceField}\u0000${targetId}`
  if (seen.has(key)) return
  seen.add(key)
  refs.push({id: targetId, alias: targetId, sourceField})
}

const projectedRefsForField = (
  block: BlockData,
  schema: AnyPropertySchema | undefined,
  sourceField: string,
): BlockReference[] => {
  if (schema === undefined || !(sourceField in block.properties)) return []
  const encodedValue = block.properties[sourceField]
  const refs: BlockReference[] = []
  const seen = new Set<string>()
  if (isRefCodec(schema.codec)) {
    try {
      appendRefProjection(refs, seen, sourceField, schema.codec.decode(encodedValue))
    } catch {
      return []
    }
    return refs
  }
  if (isRefListCodec(schema.codec)) {
    try {
      for (const id of schema.codec.decode(encodedValue)) {
        appendRefProjection(refs, seen, sourceField, id)
      }
    } catch {
      return []
    }
  }
  return refs
}

/** Reprojection scans can outlive a later schema swap. Keep the
 *  scheduled schema when its ref-ness still matches the live registry;
 *  otherwise project against the live registry so an old scan cannot
 *  re-add refs for a field that is no longer ref-typed. */
const latestRefProjectionSchema = (
  scheduledSchemas: ReadonlyMap<string, AnyPropertySchema>,
  currentSchemas: ReadonlyMap<string, AnyPropertySchema>,
  name: string,
): AnyPropertySchema | undefined => {
  const scheduledSchema = scheduledSchemas.get(name)
  const currentSchema = currentSchemas.get(name)
  return refCodecKind(scheduledSchema) === refCodecKind(currentSchema)
    ? scheduledSchema
    : currentSchema
}

/** A named rebuild step. Declares which facets it reads via `inputs`
 *  so the runtime contribution path can run only the steps whose
 *  inputs changed. Outputs are written to Repo private fields by the
 *  `run` callback's side effect; we don't return them so the
 *  framework stays minimal. */
interface RebuildStep {
  readonly id: string
  readonly inputs: readonly Facet<unknown, unknown>[]
  readonly run: (runtime: FacetRuntime) => void
}

export interface RepoOptions {
  db: PowerSyncDb
  cache: BlockCache
  user: User
  /** Read-only mode disables `BlockDefault` / `References` writes.
   *  `UiState` stays local-only and `UserPrefs` degrades to local-only.
   *  Default false. */
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
  /** When true (default), kernel mutators are registered at
   *  construction time so `repo.mutate.indent({...})` works
   *  immediately. Set false when a test wants to populate the registry
   *  explicitly (or when `setFacetRuntime` is the only registration
   *  path). */
  registerKernelMutators?: boolean
  /** When true (default), kernel post-commit processors are registered
   *  at construction time. The kernel set is currently empty; plugin
   *  processors arrive through `setFacetRuntime`. Kept as a test/tooling
   *  switch for any future core-only processors. */
  registerKernelProcessors?: boolean
  /** When true (default), kernel same-tx processors are registered at
   *  construction time. Today that's `core.normalizeReferences`. Set
   *  false in tests that need to exercise the engine without
   *  reference normalization (e.g. asserting raw-shape round-trip). */
  registerKernelSameTxProcessors?: boolean
  /** When true (default), kernel queries are registered at construction
   *  time so `repo.query.subtree({id})` etc. work immediately without a
   *  `setFacetRuntime` call. Set false when a test wants to populate
   *  the query registry explicitly. Mirrors `registerKernelMutators` /
   *  `registerKernelProcessors`. */
  registerKernelQueries?: boolean
  /** When true (default), the kernel `kernelInvalidationRule` is
   *  registered at construction time so `core.byType` / `core.typedBlocks`
   *  / alias / content queries fire correctly without a `setFacetRuntime`
   *  call. Tests that want to populate the invalidation-rules registry
   *  explicitly can disable this. */
  registerKernelInvalidationRules?: boolean
  /** When true (default), the row_events tail subscription is started
   *  at construction time so sync-applied writes propagate into the
   *  cache + invalidate handles (spec §9.3). Set false in unit tests
   *  that want explicit control over tail timing — they can call
   *  `repo.startRowEventsTail({initialLastId: 0})` to opt back in
   *  with deterministic semantics. */
  startRowEventsTail?: boolean
  /** Options forwarded to the row_events tail when started. */
  rowEventsTailOptions?: RowEventsTailOptions
}

/** Structured payload of the `block_aliases_workspace_alias_unique`
 *  trigger's RAISE message. See `clientSchema.ts` for the SQL that
 *  builds it. The trigger encodes everything it cheaply can (the SQL
 *  RAISE context has NEW.* but no committed table reads) so the JS
 *  side only does a single PK-style lookup for the rest. */
interface ParsedAliasCollision {
  workspaceId: string
  alias: string
  /** The block that the user tried to make claim the alias — the
   *  attempting row. */
  attemptedBlockId: string
}

const ALIAS_COLLISION_RAISE_PREFIX = 'alias_collision'
const PARENT_DELETED_RAISE_PREFIX = 'parent_deleted'
// ASCII unit-separator delimits the (hex-encoded) fields. Field
// contents are hex so the separator is guaranteed-distinct from
// any field byte — earlier comments asserted the codec rejected
// control chars, but `codecs.string` only checks typeof; the
// encoding can't rely on that. The trigger uses `char(31)` for
// the same delimiter and `hex(NEW.<col>)` for each field.
const ALIAS_COLLISION_FIELD_SEP = '\x1f'

/** Decode SQLite's `hex()` output (uppercase hex of the UTF-8 bytes)
 *  back to the original string. Empty input decodes to `''`. */
const decodeHexUtf8 = (hex: string): string => {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
  }
  return new TextDecoder().decode(bytes)
}

/** Recognise the trigger-raised parent-deleted error from
 *  `blocks_parent_not_deleted_check_{insert,update}`. The payload is
 *  the bare parent id — block ids are UUIDs or deterministic ids
 *  (hex + `:` / `-`), so the unit separator never appears in them
 *  and the hex encoding the alias parser needs isn't required here.
 *  Returns the parsed id on match, `null` otherwise. */
const parseParentDeletedError = (err: unknown): {parentId: string} | null => {
  if (err === null || typeof err !== 'object') return null
  const msg = (err as {message?: unknown}).message
  if (typeof msg !== 'string') return null
  const needle = `${PARENT_DELETED_RAISE_PREFIX}${ALIAS_COLLISION_FIELD_SEP}`
  const idx = msg.indexOf(needle)
  if (idx === -1) return null
  const tail = msg.slice(idx + needle.length)
  // SQLite wrappers may append context text after the payload, so
  // split on the unit separator and take the first part. Block ids
  // never contain `\x1f`, so the first part is the id verbatim.
  const parentId = tail.split(ALIAS_COLLISION_FIELD_SEP)[0]
  if (parentId.length === 0) return null
  return {parentId}
}

/** Recognise the trigger-raised alias-collision error inside whatever
 *  wrapping SQLite + better-sqlite3 + PowerSync layer it on. Returns
 *  parsed fields when matched, `null` otherwise (the caller falls
 *  back to its existing error handling). The three field values are
 *  hex-encoded in the RAISE message so the unit-separator can be
 *  used as a delimiter regardless of what bytes the alias text
 *  contains. */
const parseAliasCollisionError = (err: unknown): ParsedAliasCollision | null => {
  if (err === null || typeof err !== 'object') return null
  const msg = (err as {message?: unknown}).message
  if (typeof msg !== 'string') return null
  const needle = `${ALIAS_COLLISION_RAISE_PREFIX}${ALIAS_COLLISION_FIELD_SEP}`
  const idx = msg.indexOf(needle)
  if (idx === -1) return null
  const tail = msg.slice(idx + needle.length)
  // tail = `<HEX(workspaceId)>\x1f<HEX(alias)>\x1f<HEX(attemptedBlockId)>`
  // possibly followed by SQLite wrapper text. The hex alphabet is
  // [0-9A-F], so any byte from the wrapper that ISN'T hex (typically
  // it starts with a quote or a colon) terminates the third field.
  // Splitting on the separator yields three hex-only parts whose
  // tail may carry wrapper garbage on the third field — we
  // hex-decode each, stopping at the first non-hex character on the
  // last field to avoid eating any wrapper suffix.
  const parts = tail.split(ALIAS_COLLISION_FIELD_SEP)
  if (parts.length < 3) return null
  const trimToHex = (s: string): string => {
    const m = s.match(/^[0-9A-Fa-f]*/)
    const hex = m === null ? '' : m[0]
    // hex() emits pairs of nibbles; if a wrapper byte landed on an
    // odd boundary somehow, drop the trailing half-pair.
    return hex.length % 2 === 0 ? hex : hex.slice(0, -1)
  }
  try {
    return {
      workspaceId: decodeHexUtf8(trimToHex(parts[0])),
      alias: decodeHexUtf8(trimToHex(parts[1])),
      attemptedBlockId: decodeHexUtf8(trimToHex(parts[2])),
    }
  } catch {
    return null
  }
}

export class Repo {
  readonly db: PowerSyncDb
  readonly cache: BlockCache
  user: User
  /** Read-only mode disables `BlockDefault` / `References` writes;
   *  UI-state writes still pass through, and UserPrefs writes pass
   *  through as local-ephemeral. Mutate via
   *  `repo.setReadOnly(value)` rather than direct field assignment so
   *  callers from inside React hooks don't trip
   *  `react-hooks/immutability` lint (the mutation should travel
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
  private _propertySchemas: ReadonlyMap<string, AnyPropertySchema> = KERNEL_PROPERTY_SCHEMA_MAP
  private _propertyEditorOverrides: ReadonlyMap<string, AnyPropertyEditorOverride> = new Map()
  private _valuePresets: ReadonlyMap<string, AnyValuePreset> = new Map()
  private invalidationRules: readonly InvalidationRule[] = []
  /** Currently-installed FacetRuntime, retained so
   *  `setRuntimeContributions` can mutate runtime contribution buckets
   *  without going through a fresh runtime resolution. Null until the
   *  first setFacetRuntime call. */
  private runtime: FacetRuntime | null = null
  /** Per-facet listener disposers from `onFacetChange` registrations.
   *  Cleared when `setFacetRuntime` swaps to a fresh runtime — old
   *  listeners would fire against stale rebuild closures otherwise. */
  private runtimeFacetUnsubs: Array<() => void> = []
  /** Repo-owned runtime contribution buckets. Persisted across
   *  `setFacetRuntime` swaps and replayed onto the fresh runtime so
   *  user-data schemas (et al.) survive the dynamic-extension reload.
   *  Without this, the user-data bucket would live only on whichever
   *  FacetRuntime was current at `setRuntimeContributions` time and
   *  evaporate on the next `setFacetRuntime`. */
  private readonly runtimeContributionBuckets = new Map<string, Map<string, readonly unknown[]>>()
  /** Per-facet refs needed to replay buckets onto a fresh runtime —
   *  setRuntimeContributions takes a `Facet` reference (not a string
   *  id), so we cache it the first time the caller passes one. */
  private readonly runtimeContributionFacets = new Map<string, Facet<unknown, unknown>>()
  /** Listeners for property-schema map changes (full rebuild OR
   *  runtime-bucket update). Used by `usePropertySchemas` to drive
   *  React reruns. */
  private readonly propertySchemasListeners = new Set<() => void>()
  /** Listeners for property-editor-override map changes. */
  private readonly propertyEditorOverridesListeners = new Set<() => void>()
  /** Listeners for value-preset map changes. */
  private readonly valuePresetsListeners = new Set<() => void>()
  /** Listeners for user-surfaceable errors thrown from inside a
   *  `repo.tx` — currently `ProcessorRejection` from same-tx
   *  processors. Subscribers are responsible for the UI side
   *  (toast routing); the data layer stays UI-agnostic. */
  private readonly userErrorListeners = new Set<(error: ProcessorRejection) => void>()
  /** Rebuild step descriptors. Defined once per Repo at construction;
   *  each step declares which facets it reads. `setFacetRuntime` runs
   *  every step; `setRuntimeContributions` runs only the steps whose
   *  inputs include the changed facet. */
  private readonly rebuildSteps: readonly RebuildStep[] = []
  /** Per-query-name generation counter. Bumped by `setFacetRuntime`
   *  (and `__setQueriesForTesting`) whenever a name's registered Query
   *  instance changes — including when a name is added or removed. The
   *  generation is folded into the query handle-store key so cached
   *  handles that closed over the OLD resolver no longer collide with
   *  fresh lookups, which produce a new LoaderHandle bound to the NEW
   *  resolver. Old handles GC after their subscribers detach (the
   *  HandleStore's normal ref-count path). Reviewer P2: prevents
   *  same-name plugin updates from continuing to dispatch through the
   *  pre-swap resolver / argsSchema. */
  private queryGenerations: Map<string, number> = new Map()
  private readonly processorRunner: ProcessorRunner
  /** Per-scope undo / redo stacks (spec §10 step 7, §17 line 2228).
   *  `repo.tx` records every undoable commit here; `repo.undo` /
   *  `repo.redo` pop entries and replay them via `TxImpl.applyRaw`. */
  readonly undoManager: UndoManager
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
   *  invalidation: TxEngine fast path + row_events tail (Phase 2.C)
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
  }
  /** Lazy in-memory mirror of the per-name reprojection markers in
   *  `client_schema_state` (rows keyed `reproject_ref:<name>`). `null`
   *  until the first reprojection call hydrates it via a single
   *  `SELECT key … LIKE 'reproject_ref:%'` round-trip; afterwards
   *  `reprojectRefTypedProperties` skips ref-typed names already in
   *  this set without further SQL. Tests / migrations that wipe the
   *  table can call `__resetReprojectionMarkerCache` to force a reload. */
  private reprojectionMarkers: Set<string> | null = null
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
  /** Active row_events tail (spec §9.3 path 2). Lazy: created on first
   *  start, replaced on subsequent starts. Tests can `dispose()` and
   *  re-`start` for deterministic flushing. */
  private rowEventsTail: RowEventsTail | null = null
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
      this.cache.applySyncSnapshot(data)
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

  get propertyEditorOverrides(): ReadonlyMap<string, AnyPropertyEditorOverride> {
    return this._propertyEditorOverrides
  }

  get valuePresets(): ReadonlyMap<string, AnyValuePreset> {
    return this._valuePresets
  }

  /** Deterministic id of the workspace's Properties page (parent of
   *  all `'property-schema'` blocks). Created lazily by
   *  `getOrCreatePropertiesPage` during workspace bootstrap. */
  get propertiesPageId(): string | null {
    if (!this._activeWorkspaceId) return null
    return propertiesPageBlockId(this._activeWorkspaceId)
  }

  /** UserSchemasService singleton bound to this Repo. Owns the
   *  user-data contribution bucket on `propertySchemasFacet`; sharing
   *  one instance means imperative call sites (the AddPropertyForm,
   *  the Roam importer) all hit the same in-memory list rather than
   *  each fresh instance clobbering the bucket from an empty start.
   *  The block-subscription path is opt-in via `start()`; the React
   *  provider starts it once per workspace. */
  readonly userSchemas: UserSchemasService = new UserSchemasService(this)

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
    // row_events tail all consume `this.db` — they all get the wrapped
    // surface for free. External callers that hold the original
    // `opts.db` reference are NOT instrumented; pass `repo.db` if you
    // want timings (or use `repo.runQuery` / `repo.tx` which already
    // route through it). The wrapper has the same shape, so existing
    // type contracts hold.
    this.db = wrapDbWithMetrics(opts.db, this.dbMetrics) as PowerSyncDb
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
    // Register kernel contributions by default. setFacetRuntime
    // overrides with the merged kernel + plugin registry once a
    // runtime is supplied; callers can pass `registerKernel*` flags as
    // `false` to start empty for that facet (used by tests + tooling
    // that want explicit registration semantics).
    if (opts.registerKernelMutators ?? true) {
      this.registerMutators(KERNEL_MUTATORS)
    }
    if (opts.registerKernelProcessors ?? true) {
      for (const p of KERNEL_PROCESSORS) this.processors.set(p.name, p)
    }
    if (opts.registerKernelSameTxProcessors ?? true) {
      for (const p of KERNEL_SAME_TX_PROCESSORS) this.sameTxProcessors.set(p.name, p)
    }
    if (opts.registerKernelQueries ?? true) {
      for (const q of KERNEL_QUERIES) this.queries.set(q.name, q)
    }
    if (opts.registerKernelInvalidationRules ?? true) {
      this.invalidationRules = [kernelInvalidationRule]
    }
    // Initialize the processor runner. The runner needs a Repo
    // reference for opening processor txs; passing `this` is safe
    // because runner methods only use it post-construction (during
    // dispatch). The runner reads its registry per-tx from the snapshot
    // baked into TxResult — we don't sync a registry into the runner
    // here.
    this.processorRunner = new ProcessorRunner(this, this.db)
    this.undoManager = new UndoManager()
    // Build the rebuild step list. Each step declares the facets it
    // reads via `inputs`; the constructor wires per-facet change
    // listeners so a runtime-bucket update only re-runs the steps
    // whose inputs changed (per user-defined-properties §3).
    this.rebuildSteps = this._makeRebuildSteps()
    // Bind dispatchMutator to `this` so the Proxy's get trap doesn't
    // need to alias `this` to a local. Each name lookup returns a
    // fresh dispatcher closure; that's fine, the underlying registry
    // lookup is a single Map.get.
    const dispatch = this.dispatchMutator.bind(this)
    this.mutate = new Proxy({} as Record<string, (args: unknown) => Promise<unknown>>, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined
        return dispatch(prop)
      },
    }) as MutateProxy
    // Same Proxy shape as `mutate`, dispatching to `dispatchQuery`.
    // Each name access returns a fresh dispatcher closure; the closure
    // does the registry lookup + argsSchema validation + handleStore
    // getOrCreate on call. Identity stability is provided by the
    // handle-store key, not by memoizing the dispatcher itself.
    const dispatchQ = this.dispatchQuery.bind(this)
    this.query = new Proxy({} as Record<string, (args: unknown) => LoaderHandle<unknown>>, {
      get: (_target, prop) => {
        if (typeof prop !== 'string') return undefined
        return dispatchQ(prop)
      },
    }) as QueryProxy
    // Start the row_events tail by default (spec §9.3). Tests that
    // want deterministic timing pass startRowEventsTail: false and
    // call repo.startRowEventsTail({initialLastId: 0}) themselves
    // before issuing sync-style writes.
    if (opts.startRowEventsTail ?? true) {
      this.startRowEventsTail(opts.rowEventsTailOptions)
    }
  }

  /** Start the row_events tail subscription (spec §9.3). Idempotent
   *  in spirit: if a tail is already running, it's disposed first so
   *  the new options take effect. Returns the tail for inspection /
   *  manual flushing. */
  startRowEventsTail(options?: RowEventsTailOptions): RowEventsTail {
    if (this.rowEventsTail) this.rowEventsTail.dispose()
    this.rowEventsTail = startRowEventsTail({
      db: this.db,
      cache: this.cache,
      handleStore: this.handleStore,
      getInvalidationRules: () => this.invalidationRules,
      options,
    })
    return this.rowEventsTail
  }

  /** Dispose the active row_events tail (no-op if none). Tests use
   *  this to detach the subscription before tearing down the test DB. */
  stopRowEventsTail(): void {
    if (this.rowEventsTail) {
      this.rowEventsTail.dispose()
      this.rowEventsTail = null
    }
  }

  /** Manually flush the row_events tail — synchronously consumes any
   *  rows not yet processed and walks `handleStore.invalidate(...)`.
   *  Tests use this instead of waiting on the throttle window. */
  async flushRowEventsTail(): Promise<void> {
    if (this.rowEventsTail) await this.rowEventsTail.flush()
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
   *      `applySyncSnapshotCalls`, `applySyncSnapshotRejected`,
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
    }>
  }> {
    return Object.freeze({
      handleStore: this.handleStore.metrics.snapshot(),
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
   *  Concurrency note: this method does NOT use `BlockCache.dedupLoad`.
   *  That helper keys by id only, which silently merged a plain
   *  `repo.load(id)` with a concurrent `repo.load(id, {children: true})`
   *  — the second caller would see the plain promise resolve and miss
   *  the children. Inlining the load costs at most one extra row read
   *  per concurrent caller; the cache's `setSnapshot` is
   *  fingerprint-deduplicated so listeners don't fire twice. */
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
    this.cache.applySyncSnapshot(data)

    if (opts?.children) await this.hydrateChildren(id)

    if (opts?.ancestors) {
      // Pass id twice — ANCESTORS_SQL uses it as both start and skip.
      const ancestorRows = await this.db.getAll<BlockRow>(ANCESTORS_SQL, [id, id])
      for (const r of ancestorRows) this.cache.applySyncSnapshot(parseBlockRow(r))
    }

    if (opts?.descendants) {
      const subtreeRows = await this.db.getAll<BlockRow & {depth: number}>(SUBTREE_SQL, [id])
      const maxDepth = typeof opts.descendants === 'number' ? opts.descendants : Infinity
      for (const r of subtreeRows) {
        if (r.depth > maxDepth) continue
        this.cache.applySyncSnapshot(parseBlockRow(r))
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
    this._activeWorkspaceId = workspaceId
  }

  /** Toggle read-only mode. Wrapping the field write in a method
   *  keeps call sites that come from inside React hooks lint-clean
   *  (`react-hooks/immutability` flags direct property writes on
   *  hook outputs). UI-state writes still pass through regardless of
   *  this flag; UserPrefs writes pass through but stop uploading. */
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
    // Step 7 of the §10 pipeline — record undo entry. Non-undoable
    // scopes and zero-write txs are filtered inside `record`. Replays go
    // through `_replay`, not here, so they don't add new history.
    this.undoManager.record({
      scope: opts.scope,
      txId: result.txId,
      snapshots: result.snapshots,
      description: opts.description,
    })
    return result.value
  }

  /** Undo the most recent committed `repo.tx` for `scope`. Default
   *  scope is `BlockDefault` (the cmd-Z target). Resolves to true if
   *  an entry was popped + replayed, false if the stack was empty.
   *  Replay opens its own `repo.tx` with `source = 'user'` so the
   *  inverse syncs upstream just like the original write did (per the
   *  spec's §7.3 + the follow-ups doc's "undo of a content edit
   *  should sync the un-edit"). Throws `ReadOnlyError` in read-only
   *  mode for scopes that cannot write locally — matches normal
   *  `repo.tx` gating. */
  async undo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    const entry = this.undoManager.popUndo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'before')
      this.undoManager.pushRedo(scope, entry)
      return true
    } catch (err) {
      // Replay failed — push the entry back so the user can retry
      // (e.g. after toggling read-only off, fixing a missing parent).
      this.undoManager.pushUndo(scope, entry)
      throw err
    }
  }

  /** Redo the most recently undone tx for `scope`. Same default + same
   *  semantics as `undo`, mirrored. */
  async redo(scope: ChangeScope = ChangeScope.BlockDefault): Promise<boolean> {
    const entry = this.undoManager.popRedo(scope)
    if (entry === null) return false
    try {
      await this._replay(entry, 'after')
      this.undoManager.pushUndo(scope, entry)
      return true
    } catch (err) {
      this.undoManager.pushRedo(scope, entry)
      throw err
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
  private async _runAndDispatch<R>(
    fn: (tx: Tx) => Promise<R>,
    opts: RepoTxOptions,
  ) {
    const txT0 = performance.now()
    let result
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
      })
    } catch (err) {
      const collision = parseAliasCollisionError(err)
      if (collision !== null) {
        const rejection = await this.buildAliasCollisionRejection(collision)
        this.fireUserErrorListeners(rejection)
        throw rejection
      }
      const parentDeleted = parseParentDeletedError(err)
      if (parentDeleted !== null) {
        throw new ParentDeletedError(parentDeleted.parentId)
      }
      if (err instanceof ProcessorRejection) this.fireUserErrorListeners(err)
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
    }, {scope: entry.scope, description})
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

  private resolveTypedBlockQuery(query: TypedBlockQuery): ResolvedTypedBlockQuery | null {
    const workspaceId = query.workspaceId ?? this.activeWorkspaceId
    if (!workspaceId) return null
    return normalizeTypedBlockQuery({
      workspaceId,
      types: query.types,
      where: query.where,
      referencedBy: query.referencedBy,
      match: query.match,
      exclude: query.exclude,
      order: query.order,
    })
  }

  /** Run a typed block query once. `workspaceId` defaults to the
   *  repo's active workspace; missing workspace returns an empty list. */
  async queryBlocks(query: TypedBlockQuery): Promise<BlockData[]> {
    const resolved = this.resolveTypedBlockQuery(query)
    if (resolved === null) return []
    return this.query.typedBlocks(resolved).load()
  }

  /** Subscribe to a typed block query. `workspaceId` defaults to the
   *  repo's active workspace at subscription time. */
  subscribeBlocks(
    query: TypedBlockQuery,
    listener: (rows: BlockData[]) => void,
  ): Unsubscribe {
    const resolved = this.resolveTypedBlockQuery(query)
    if (resolved === null) {
      queueMicrotask(() => listener([]))
      return () => {}
    }
    const handle = this.query.typedBlocks(resolved)
    const current = handle.peek()
    if (current !== undefined) queueMicrotask(() => listener(current))
    return handle.subscribe(listener)
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

  /** Update the data-layer registries from a FacetRuntime. Spec §8.
   *  Decomposes into named rebuild steps (per user-defined-properties
   *  §3); the same step set runs for full-runtime swaps and for the
   *  per-facet `setRuntimeContributions` change path. Kernel mutators
   *  must be present in the runtime if the caller wants them — pass
   *  them in via the static-facet bundle the kernel ships. */
  setFacetRuntime(runtime: FacetRuntime): void {
    // Drop any per-facet change subscriptions on the previous runtime —
    // we're about to rewire to a fresh one. Subscriptions live on the
    // FacetRuntime instance, not on Repo, so swapping runtimes
    // implicitly drops them; this list just clears our tracking.
    for (const dispose of this.runtimeFacetUnsubs) dispose()
    this.runtimeFacetUnsubs = []
    this.runtime = runtime

    // Replay any persisted runtime contribution buckets onto the fresh
    // runtime so user-data schemas survive the swap. Doing this before
    // running rebuild steps means the steps see the merged view on
    // first read (no flicker through a state where user-data is
    // missing and then re-added).
    for (const [facetId, bucketsBySource] of this.runtimeContributionBuckets) {
      const facet = this.runtimeContributionFacets.get(facetId)
      if (!facet) continue
      for (const [sourceId, contributions] of bucketsBySource) {
        runtime.setRuntimeContributions(facet, sourceId, contributions)
      }
    }

    // Run every rebuild step on the fresh runtime.
    for (const step of this.rebuildSteps) step.run(runtime)

    // Wire per-facet change notifications: when a runtime-contribution
    // bucket on `facet` changes, re-run only the steps that read it.
    const stepsByFacetId = new Map<string, RebuildStep[]>()
    for (const step of this.rebuildSteps) {
      for (const input of step.inputs) {
        const list = stepsByFacetId.get(input.id) ?? []
        list.push(step)
        stepsByFacetId.set(input.id, list)
      }
    }
    for (const [facetId, steps] of stepsByFacetId) {
      const unsub = runtime.onFacetChange(facetId, () => {
        for (const step of steps) step.run(runtime)
      })
      this.runtimeFacetUnsubs.push(unsub)
    }
  }

  /** Replace the runtime contribution bucket for `facet` keyed by
   *  `sourceId`. Triggers a re-run of every rebuild step whose
   *  declared inputs include this facet, plus per-facet listener
   *  fan-out for React subscribers (e.g. usePropertySchemas).
   *  No-op if no FacetRuntime has been installed yet — callers must
   *  setFacetRuntime first. */
  setRuntimeContributions<Input>(
    facet: Facet<Input, unknown>,
    sourceId: string,
    contributions: readonly Input[],
  ): void {
    if (!this.runtime) {
      throw new Error('[Repo.setRuntimeContributions] called before setFacetRuntime')
    }
    // Persist the bucket on Repo so it survives `setFacetRuntime`
    // swaps. We also cache the facet reference (the runtime's
    // setRuntimeContributions takes a Facet, not just an id).
    this.runtimeContributionFacets.set(facet.id, facet as Facet<unknown, unknown>)
    let bucketsBySource = this.runtimeContributionBuckets.get(facet.id)
    if (contributions.length === 0) {
      bucketsBySource?.delete(sourceId)
      if (bucketsBySource && bucketsBySource.size === 0) {
        this.runtimeContributionBuckets.delete(facet.id)
        this.runtimeContributionFacets.delete(facet.id)
      }
    } else {
      if (!bucketsBySource) {
        bucketsBySource = new Map<string, readonly unknown[]>()
        this.runtimeContributionBuckets.set(facet.id, bucketsBySource)
      }
      bucketsBySource.set(sourceId, contributions as readonly unknown[])
    }
    this.runtime.setRuntimeContributions(facet, sourceId, contributions)
  }

  /** Subscribe to changes on `_propertySchemas`. Fires when
   *  `setFacetRuntime` rebuilds the schema map AND when
   *  `setRuntimeContributions(propertySchemasFacet, ...)` updates the
   *  user-data bucket. Used by `usePropertySchemas` so React rerenders
   *  on user-schema add/edit/remove without a runtime swap. */
  onPropertySchemasChange(listener: () => void): () => void {
    this.propertySchemasListeners.add(listener)
    return () => { this.propertySchemasListeners.delete(listener) }
  }

  /** Subscribe to changes on the merged `propertyEditorOverrides` map
   *  (currently driven exclusively by `propertyEditorOverridesFacet`,
   *  but exposed as a Repo-level event so future runtime-contribution
   *  paths layer on without changing the consumer surface). */
  onPropertyEditorOverridesChange(listener: () => void): () => void {
    this.propertyEditorOverridesListeners.add(listener)
    return () => { this.propertyEditorOverridesListeners.delete(listener) }
  }

  /** Subscribe to changes on the value-preset map. */
  onValuePresetsChange(listener: () => void): () => void {
    this.valuePresetsListeners.add(listener)
    return () => { this.valuePresetsListeners.delete(listener) }
  }

  /** Subscribe to user-surfaceable errors thrown from `repo.tx`
   *  (currently `ProcessorRejection` from same-tx processors). The
   *  data layer fires; the UI layer (e.g. toast) listens. Returns an
   *  unsubscribe fn. Listeners that throw are caught and logged so
   *  one bad listener can't poison the others or break the
   *  underlying `repo.tx` error propagation. */
  onUserError(listener: (error: ProcessorRejection) => void): () => void {
    this.userErrorListeners.add(listener)
    return () => { this.userErrorListeners.delete(listener) }
  }

  /** Notify all subscribed user-error listeners. Each listener's
   *  exception is caught + logged so one bad listener can't break
   *  the others or interrupt error propagation back to the caller. */
  private fireUserErrorListeners(err: ProcessorRejection): void {
    for (const listener of [...this.userErrorListeners]) {
      try { listener(err) } catch (e) {
        console.warn('[repo.userErrorListeners] listener threw:', e)
      }
    }
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
      },
    )
  }

  snapshotTypeRegistries(): TypeRegistrySnapshot {
    return {types: this._types, propertySchemas: this._propertySchemas}
  }

  private async reprojectRefTypedProperties(
    propertyNames: readonly string[],
    propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
  ): Promise<void> {
    if (this.isReadOnly || propertyNames.length === 0) return
    const t0 = performance.now()
    let blocksUpdated = 0
    let scanScheduled = false
    try {
      // Filter out names that have already been reprojected on this
      // device AND are still ref-typed in `propertySchemas`. The
      // references processor has been maintaining `references_json`
      // incrementally on every write since the marker landed, so a
      // re-scan would be pure overhead. Names whose current schema is
      // no longer ref-typed (cleanup case) always run regardless of the
      // marker; we want to strip stale refs from `references_json`.
      const markers = await this.loadReprojectionMarkers()
      const namesToScan: string[] = []
      let skippedByMarker = 0
      for (const name of propertyNames) {
        const kind = refCodecKind(propertySchemas.get(name))
        if (kind !== undefined && markers.has(name)) {
          skippedByMarker += 1
          continue
        }
        namesToScan.push(name)
      }
      this.reprojectionMetrics.skippedByMarker += skippedByMarker
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
            AND prop.key IN (${placeholders})
        `,
        [...namesToScan],
      )
      this.reprojectionMetrics.rowsScanned += rows.length
      // Note: we do NOT bail when `this._propertySchemas !== propertySchemas`.
      // `AppRuntimeProvider` calls `setFacetRuntime` twice during cold-start
      // (kernel+static, then async with dynamic extensions), so a follow-up
      // setFacetRuntime always lands while reprojection-1 is mid-SELECT —
      // bailing here meant reprojection-1 never wrote markers and the same
      // 1.4 s scan repeated on every reload. Dynamic extensions are additive
      // (no codec redefinitions), so reprojection-1's snapshot is still
      // correct against the current state; per-block tx.get reads live
      // references and the JSON.stringify diff skips writes when nothing
      // changed. If a real codec redefinition ever races a reprojection,
      // the rebuild step's follow-up reprojection corrects it.
      // Even when `rows.length === 0` we still want to record the
      // markers below so the next cold start short-circuits — for many
      // plugin-contributed ref schemas there's simply no legacy data,
      // and we should stamp them as "caught up" the first time.

      const propertyNameSet = new Set(namesToScan)

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
            const retainedRefs = liveBlock.references.filter(ref =>
              !ref.sourceField || !propertyNameSet.has(ref.sourceField)
            )
            const addedRefs = namesToScan.flatMap(name =>
              projectedRefsForField(
                liveBlock,
                latestRefProjectionSchema(propertySchemas, this._propertySchemas, name),
                name,
              )
            )
            const nextReferences = [...retainedRefs, ...addedRefs]
            if (JSON.stringify(liveBlock.references) === JSON.stringify(nextReferences)) continue
            await tx.update(liveBlock.id, {references: nextReferences}, {skipMetadata: true})
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
        const schema = latestRefProjectionSchema(propertySchemas, this._propertySchemas, name)
        const kind = refCodecKind(schema)
        if (kind === undefined) {
          await this.clearReprojectionMarker(name)
        } else {
          await this.setReprojectionMarker(name)
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
   *  Browser path: `requestIdleCallback` with a 2 s safety timeout —
   *  we want to wait until the main thread is idle, but never longer
   *  than that (so a busy session still gets its catch-up scan).
   *  Test / Node path: `setTimeout(0)` so vitest fake timers can
   *  advance the call deterministically; `requestIdleCallback` is not
   *  defined under jsdom / Node. */
  private scheduleReprojection(
    names: readonly string[],
    schemas: ReadonlyMap<string, AnyPropertySchema>,
  ): void {
    const run = () => { void this.reprojectRefTypedProperties(names, schemas) }
    const idle = (globalThis as {requestIdleCallback?: (cb: () => void, opts?: {timeout: number}) => void}).requestIdleCallback
    if (typeof idle === 'function') {
      idle(run, {timeout: 2000})
    } else {
      setTimeout(run, 0)
    }
  }

  /** Lazy load the per-name marker set on first call, then keep it
   *  in-memory. One SQL round-trip per Repo lifetime. */
  private async loadReprojectionMarkers(): Promise<Set<string>> {
    if (this.reprojectionMarkers !== null) return this.reprojectionMarkers
    const rows = await this.db.getAll<{key: string}>(SELECT_REPROJECT_REF_MARKERS_SQL)
    const set = new Set<string>()
    for (const r of rows) set.add(r.key.slice(REPROJECT_REF_MARKER_PREFIX.length))
    this.reprojectionMarkers = set
    return set
  }

  private async setReprojectionMarker(name: string): Promise<void> {
    await this.db.execute(RECORD_REPROJECT_REF_MARKER_SQL, [`${REPROJECT_REF_MARKER_PREFIX}${name}`])
    this.reprojectionMarkers?.add(name)
  }

  private async clearReprojectionMarker(name: string): Promise<void> {
    await this.db.execute(CLEAR_REPROJECT_REF_MARKER_SQL, [`${REPROJECT_REF_MARKER_PREFIX}${name}`])
    this.reprojectionMarkers?.delete(name)
  }

  /** Test escape hatch — drop the in-memory marker mirror so the next
   *  reprojection re-reads from `client_schema_state`. Used by tests
   *  that mutate the table out-of-band to simulate cross-session state. */
  __resetReprojectionMarkerCache(): void {
    this.reprojectionMarkers = null
  }

  private async _addTypeInTx(
    tx: Tx,
    types: ReadonlyMap<string, TypeContribution>,
    propertySchemas: ReadonlyMap<string, AnyPropertySchema>,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const contribution = types.get(typeId)
    if (contribution === undefined) {
      throw new Error(
        `[addType] type id ${JSON.stringify(typeId)} is not registered. ` +
        'Register a TypeContribution through typesFacet before calling addType.',
      )
    }
    const block = await tx.get(blockId)
    if (!block) return

    const current = getBlockTypes(block)
    const wasNew = !current.includes(typeId)
    const next: Record<string, unknown> = {...block.properties}
    let propsChanged = false

    if (wasNew) {
      next[typesProp.name] = typesProp.codec.encode([...current, typeId])
      propsChanged = true
    }

    for (const [name, value] of Object.entries(initialValues)) {
      if (next[name] !== undefined) continue
      const schema = propertySchemas.get(name)
      if (schema === undefined) {
        throw new Error(
          `[addType] initialValues[${JSON.stringify(name)}] has no registered PropertySchema ` +
          'in the merged registry.',
        )
      }
      next[name] = schema.codec.encode(value)
      propsChanged = true
    }

    if (propsChanged) {
      await tx.update(blockId, {properties: next})
    }
    if (wasNew) {
      await contribution.setup?.({tx, id: blockId, repo: this, types, propertySchemas})
    }
  }

  private async _removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
    const block = await tx.get(blockId)
    if (!block) return
    const current = getBlockTypes(block)
    if (!current.includes(typeId)) return
    const next = {
      ...block.properties,
      [typesProp.name]: typesProp.codec.encode(current.filter(t => t !== typeId)),
    }
    await tx.update(blockId, {properties: next})
  }

  async addType(
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
  ): Promise<void> {
    const {types, propertySchemas} = this.snapshotTypeRegistries()
    await this.tx(async tx => {
      await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues)
    }, {scope: ChangeScope.BlockDefault, description: `addType ${typeId}`})
  }

  async addTypeInTx(
    tx: Tx,
    blockId: string,
    typeId: string,
    initialValues: Readonly<Record<string, unknown>> = {},
    snapshot?: TypeRegistrySnapshot,
  ): Promise<void> {
    const types = snapshot?.types ?? this._types
    const propertySchemas = snapshot?.propertySchemas ?? this._propertySchemas
    await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, initialValues)
  }

  async removeType(blockId: string, typeId: string): Promise<void> {
    await this.tx(async tx => {
      await this._removeTypeInTx(tx, blockId, typeId)
    }, {scope: ChangeScope.BlockDefault, description: `removeType ${typeId}`})
  }

  async removeTypeInTx(tx: Tx, blockId: string, typeId: string): Promise<void> {
    await this._removeTypeInTx(tx, blockId, typeId)
  }

  async toggleType(blockId: string, typeId: string): Promise<void> {
    const {types, propertySchemas} = this.snapshotTypeRegistries()
    await this.tx(async tx => {
      const block = await tx.get(blockId)
      if (!block) return
      if (getBlockTypes(block).includes(typeId)) {
        await this._removeTypeInTx(tx, blockId, typeId)
      } else {
        await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, {})
      }
    }, {scope: ChangeScope.BlockDefault, description: `toggleType ${typeId}`})
  }

  async setBlockTypes(blockId: string, typeIds: readonly string[]): Promise<void> {
    const desiredOrder = Array.from(new Set(typeIds))
    const {types, propertySchemas} = this.snapshotTypeRegistries()
    await this.tx(async tx => {
      const block = await tx.get(blockId)
      if (!block) return

      const current = getBlockTypes(block)
      const want = new Set(desiredOrder)
      for (const typeId of current) {
        if (!want.has(typeId)) await this._removeTypeInTx(tx, blockId, typeId)
      }

      const currentSet = new Set(current)
      for (const typeId of desiredOrder) {
        if (currentSet.has(typeId)) continue
        await this._addTypeInTx(tx, types, propertySchemas, blockId, typeId, {})
      }

      const after = await tx.get(blockId)
      if (!after) return
      const stored = getBlockTypes(after)
      const alreadyOrdered =
        stored.length === desiredOrder.length &&
        stored.every((typeId, index) => typeId === desiredOrder[index])
      if (alreadyOrdered) return
      await tx.update(blockId, {
        properties: {
          ...after.properties,
          [typesProp.name]: typesProp.codec.encode(desiredOrder),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'setBlockTypes'})
  }

  /** Constructor-time rebuild step factory. Each step closes over
   *  `this`; runs at full setFacetRuntime AND when its inputs' runtime
   *  contributions change. Order matters: types runs before
   *  propertySchemas (the merge folds in type-lifted schemas);
   *  propertySchemas runs before query swap if a future step ever
   *  needs it. */
  private _makeRebuildSteps(): readonly RebuildStep[] {
    return [
      {
        id: 'mutators',
        inputs: [mutatorsFacet as Facet<unknown, unknown>],
        run: (rt) => { this.mutators = new Map(rt.read(mutatorsFacet)) },
      },
      {
        id: 'processors',
        inputs: [postCommitProcessorsFacet as Facet<unknown, unknown>],
        run: (rt) => { this.processors = new Map(rt.read(postCommitProcessorsFacet)) },
      },
      {
        id: 'sameTxProcessors',
        inputs: [sameTxProcessorsFacet as Facet<unknown, unknown>],
        run: (rt) => { this.sameTxProcessors = new Map(rt.read(sameTxProcessorsFacet)) },
      },
      {
        id: 'invalidationRules',
        inputs: [invalidationRulesFacet as Facet<unknown, unknown>],
        run: (rt) => { this.invalidationRules = rt.read(invalidationRulesFacet) },
      },
      {
        // Reads typesFacet AND propertySchemasFacet — both inputs feed
        // mergeLiftedSchemas, so a change to either re-runs the merge.
        id: 'propertySchemas',
        inputs: [
          typesFacet as Facet<unknown, unknown>,
          propertySchemasFacet as Facet<unknown, unknown>,
        ],
        run: (rt) => {
          const previousPropertySchemas = this._propertySchemas
          this._types = rt.read(typesFacet)
          this._propertySchemas = mergeLiftedSchemas(
            rt.read(propertySchemasFacet),
            this._types,
          )
          const refSchemaChanges = changedRefSchemaNames(previousPropertySchemas, this._propertySchemas)
          if (refSchemaChanges.length > 0) {
            this.scheduleReprojection(refSchemaChanges, this._propertySchemas)
          }
          // Notify React subscribers (usePropertySchemas) so panels
          // re-render against the new merged map.
          for (const l of [...this.propertySchemasListeners]) {
            try { l() } catch (err) { console.error('[Repo] propertySchemas listener threw', err) }
          }
        },
      },
      {
        id: 'propertyEditorOverrides',
        inputs: [propertyEditorOverridesFacet as Facet<unknown, unknown>],
        run: (rt) => {
          this._propertyEditorOverrides = rt.read(propertyEditorOverridesFacet)
          for (const l of [...this.propertyEditorOverridesListeners]) {
            try { l() } catch (err) { console.error('[Repo] propertyEditorOverrides listener threw', err) }
          }
        },
      },
      {
        id: 'valuePresets',
        inputs: [valuePresetsFacet as Facet<unknown, unknown>],
        run: (rt) => {
          this._valuePresets = rt.read(valuePresetsFacet)
          for (const l of [...this.valuePresetsListeners]) {
            try { l() } catch (err) { console.error('[Repo] valuePresets listener threw', err) }
          }
        },
      },
      {
        id: 'queries',
        inputs: [queriesFacet as Facet<unknown, unknown>],
        run: (rt) => { this.swapQueries(new Map(rt.read(queriesFacet))) },
      },
    ]
  }

  /** Replace the query registry, bumping the per-name generation
   *  counter for every name whose registered Query instance changed
   *  (including newly-added and removed names). This invalidates the
   *  handle-store keys for those queries so subsequent dispatch
   *  produces fresh `LoaderHandle`s bound to the new resolvers. */
  private swapQueries(newQueries: Map<string, AnyQuery>): void {
    for (const [name, newQ] of newQueries) {
      if (this.queries.get(name) !== newQ) {
        this.queryGenerations.set(name, (this.queryGenerations.get(name) ?? 0) + 1)
      }
    }
    for (const oldName of this.queries.keys()) {
      if (!newQueries.has(oldName)) {
        this.queryGenerations.set(oldName, (this.queryGenerations.get(oldName) ?? 0) + 1)
      }
    }
    this.queries = newQueries
  }

  /** Wait until the post-commit processor framework has nothing
   *  pending — useful in tests + scripted scenarios that need
   *  deterministic ordering after a `repo.tx` resolves. Does NOT
   *  advance timers; jobs scheduled with `delayMs` only enter the
   *  pending set when the timer fires. */
  async awaitProcessors(): Promise<void> {
    await this.processorRunner.awaitIdle()
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
   *  Throws `MutatorNotRegisteredError` if neither matches. */
  private dispatchMutator(name: string): (args: unknown) => Promise<unknown> {
    return async (args: unknown) => {
      const m = this.mutators.get(name) ?? this.mutators.get(`core.${name}`)
      if (!m) throw new MutatorNotRegisteredError(name)
      const validated = m.argsSchema.parse(args) as never
      const scope = typeof m.scope === 'function' ? m.scope(validated) : m.scope
      return this.tx(tx => tx.run(m, validated) as Promise<unknown>, {
        scope,
        description: m.describe?.(validated),
      })
    }
  }

  /** Internal: register an array of mutators into the registry by name.
   *  Used by the constructor's `registerKernel: true` path. */
  private registerMutators(mutators: ReadonlyArray<AnyMutator>): void {
    for (const m of mutators) this.mutators.set(m.name, m)
  }

  /** Test-only escape hatch retained for stage 1.3 carryover tests
   *  that wired specific mutator sets without a FacetRuntime. New
   *  tests should prefer `setFacetRuntime` or the
   *  `registerKernel: false` constructor flag plus `setFacetRuntime`. */
  __setMutatorsForTesting(mutators: ReadonlyArray<AnyMutator>): void {
    this.mutators = new Map(mutators.map(m => [m.name, m]))
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
      const q = this.queries.get(name) ?? this.queries.get(`core.${name}`)
      if (!q) throw new QueryNotRegisteredError(name)
      const validated = q.argsSchema.parse(args) as never
      // Use the registry-stored full name in the key so the bare-name
      // shortcut (`repo.query.subtree`) and the literal full-name access
      // (`repo.query['core.subtree']`) hit the same handle slot.
      const fullName = q.name
      const gen = this.queryGenerations.get(fullName) ?? 0
      // Folding the per-name generation into the key means a swap
      // (setFacetRuntime replacing this query's instance) produces a
      // distinct handle slot — old handles GC after subscribers
      // detach; new lookups bind to the new resolver.
      const key = handleKey(`query:${fullName}@${gen}`, validated)
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
            const raw = await q.resolve(validated, {
              db: this.db,
              repo: this,
              hydrateBlocks: (rows) => this.hydrateRows(
                rows as unknown as ReadonlyArray<BlockRow>,
                {ctx, declareRowDeps: true},
              ),
              primeBlocks: (rows) => this.hydrateRows(
                rows as unknown as ReadonlyArray<BlockRow>,
                {ctx, declareRowDeps: false},
              ),
              depend: (dep) => ctx.depend(dep),
            })
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
