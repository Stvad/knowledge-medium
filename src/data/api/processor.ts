import type { BlockData } from './blockData'
import type { ChangeScope } from './changeScope'
import type { Schema } from './schema'
import type { Tx } from './tx'
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

export type PostCommitProcessor<ScheduledArgs = unknown> = {
  readonly name: string
  /** ChangeScope for the processor's own writeTransaction. Determines
   *  whether the processor's writes enter the document undo stack and
   *  whether they upload. Reference parsing uses
   *  `ChangeScope.References` (separate undo bucket; uploads); plugins
   *  pick whatever matches their semantics. */
  readonly scope: ChangeScope
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

/** Processor context. */
export interface ProcessorCtx {
  /** This processor's own tx (its own writeTransaction). Writes commit
   *  when the processor's `apply` resolves. */
  tx: Tx
  /** Raw SQL for committed-state reads. Writes through `db` are
   *  unsupported — go through `ctx.tx`. */
  db: unknown
  /** For handle composition or invoking other mutators. */
  repo: unknown
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
