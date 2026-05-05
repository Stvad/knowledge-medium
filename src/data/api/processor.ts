import type { BlockData } from './blockData'
import type { AnyPropertySchema } from './propertySchema'
// Type-only — no runtime cycle. Keeps `ProcessorCtx.repo` honest (full
// Repo capability surface for processors) without inventing a narrow
// shadow interface.
import type { Repo } from '../repo'
import type { Schema } from './schema'
import type { User } from './user'

/** Plugin-augmentable type registry for processor scheduled args.
 *  Static processors augment via `declare module '@/data/api'`; dynamic
 *  processors fall back to `unknown` and rely on runtime
 *  `scheduledArgsSchema.parse(args)` validation at enqueue.
 *  Empty body is intentional — declaration merging requires interface. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface PostCommitProcessorRegistry { /* augmented per processor */ }

export type ScheduledArgsFor<P extends string> =
  P extends keyof PostCommitProcessorRegistry
    ? PostCommitProcessorRegistry[P]
    : unknown

/** Discriminated on `watches.kind`:
 *  - `'field'`: fires when the originating tx wrote any of the named
 *    fields on `blocks`. Robust correctness path — catches every
 *    code path that touches the field. `scheduledArgs` is undefined.
 *  - `'explicit'`: fires only when a previous tx called
 *    `tx.afterCommit(name, args)`. `scheduledArgsSchema` is REQUIRED;
 *    engine validates at enqueue time. */
export type ProcessorWatches<ScheduledArgs> =
  | {
      watches: {
        kind: 'field'
        table: 'blocks'
        fields: ReadonlyArray<keyof BlockData>
      }
      scheduledArgsSchema?: never
    }
  | {
      watches: { kind: 'explicit' }
      scheduledArgsSchema: Schema<ScheduledArgs>
    }

/** A processor is a plain async function that reacts to a committed tx
 *  and decides for itself whether to read, write, or do neither. The
 *  framework does NOT auto-open a writeTransaction (v4.32 — see §5.7);
 *  if the processor wants to write, it calls `ctx.repo.tx(...)` itself.
 *
 *  This shape supports three legitimate processor modes uniformly:
 *    - pure side-effects (UI invalidation, analytics) → no tx, no cost
 *    - read-derive-cache → reads via `ctx.db`, no tx
 *    - conditional or always writes → opens its own `ctx.repo.tx(...)`
 *      with the scope it wants
 *
 *  Why no `scope` field on the processor itself: scope is a tx property,
 *  not a processor property. A processor that opens multiple txs may
 *  legitimately want different scopes per tx; one that never writes
 *  should not have to declare a scope it won't use. The processor names
 *  the scope at the `repo.tx` call site, where it's actually needed. */
export type PostCommitProcessor<ScheduledArgs = unknown> = {
  readonly name: string
  readonly apply: (
    event: CommittedEvent<ScheduledArgs>,
    ctx: ProcessorCtx,
  ) => Promise<void>
} & ProcessorWatches<ScheduledArgs>

/** A row that changed in the originating tx. Both before/after are domain
 *  shape (camelCase), populated for `kind: 'field'` processors only. */
export interface ChangedRow {
  id: string
  before: BlockData | null
  after: BlockData | null
}

/** Event passed to `processor.apply`. `workspaceId` is `string` (never
 *  null) — see the contract in §5.7. */
export interface CommittedEvent<ScheduledArgs = unknown> {
  txId: string
  changedRows: ChangedRow[]
  user: User
  workspaceId: string
  /** Populated for `kind: 'explicit'` processors. */
  scheduledArgs?: ScheduledArgs
}

/** Read-only SQL surface available to a processor outside any tx.
 *  Sees committed state at processor-fire time (the originating user
 *  tx is committed by the time `apply` fires). Intentionally narrower
 *  than `PowerSyncDatabase` — no `execute`, no `writeTransaction` — so
 *  the type prevents accidental writes through this handle. Writes
 *  must go through a `repo.tx(...)` opened by the processor. */
export interface ProcessorReadDb {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  get<T>(sql: string, params?: unknown[]): Promise<T>
}

/** Processor context (v4.32). The framework no longer auto-opens a tx;
 *  the processor decides.
 *
 *  - `db`: raw SQL for committed-state reads. The originating user tx
 *    is committed before `apply` fires, so reads see committed state.
 *    No writer is open at this surface unless the processor opens one
 *    itself via `repo.tx`, so reads don't queue behind a writer.
 *  - `repo`: full `Repo` — open a write tx (`repo.tx(fn, {scope})`)
 *    when/if the processor decides to write, invoke other mutators via
 *    `repo.mutate.*`, run registered queries.
 *    Imported here as a type-only reference; type cycles via `import
 *    type` are erased at compile time so there's no runtime cycle. */
export interface ProcessorCtx {
  /** Raw SQL for committed-state reads. The narrow shape is deliberate:
   *  `.execute()` / `.writeTransaction()` are absent so accidental writes
   *  through this handle are compile-time errors. Writes go through
   *  `ctx.repo.tx(...)`. */
  db: ProcessorReadDb
  /** Full `Repo` — open a write tx when needed, invoke mutators, run
   *  kernel queries. */
  repo: Repo
  /** Merged property-schema registry snapshotted with the processor
   *  registry at tx start. Processors use this for codec lookups
   *  without racing runtime swaps. */
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

export const definePostCommitProcessor = <ScheduledArgs = undefined>(
  processor: PostCommitProcessor<ScheduledArgs>,
): PostCommitProcessor<ScheduledArgs> => processor

/** Variance-erased processor type for storage in heterogeneous
 *  collections (the engine's processor registry, the
 *  postCommitProcessorsFacet's contributions). Same rationale as
 *  AnyMutator — `unknown` doesn't compose cleanly under
 *  contravariance, `any` is the conventional escape. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyPostCommitProcessor = PostCommitProcessor<any>
