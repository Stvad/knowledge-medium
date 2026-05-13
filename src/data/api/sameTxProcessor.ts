/**
 * Same-tx processor framework (reintroduces the mode that v4.20 of
 * the data-layer redesign dropped — see `docs/data-layer-redesign.md`
 * §16.2 and §7.1).
 *
 * Same-tx vs post-commit, in one line: same-tx fires INSIDE the
 * user's `writeTransaction` after `fn` returns but before commit;
 * post-commit fires AFTER `repo.tx` resolves, in its own tx.
 *
 * What same-tx is for: cheap, correctness-critical, single-row work
 * that must commit atomically with the originating tx — e.g.
 * reference-array normalization (currently inline in `txEngine.ts`)
 * and alias sync (content↔aliases reconciliation + alias-collision
 * rejection). Latency added here is paid by the user-commit path, so
 * it has to stay cheap.
 *
 * What same-tx is NOT for: expensive enrichment (parseReferences),
 * cross-row writes (rename rewriting backlinks across many sources),
 * delayed cleanup. Those stay post-commit per §7.1.
 *
 * Capabilities of `apply`:
 *   - Reads via `ctx.tx` — sees the live staged state of the user's
 *     tx, including writes by the user fn and writes from any
 *     same-tx processor that ran earlier in this pipeline pass.
 *   - Writes via `ctx.tx.update/setProperty/etc` — amends the user's
 *     tx; snapshot.after updates in place; the undo entry recorded
 *     for the user's tx captures these amendments alongside the
 *     user's own writes (one user undo step covers everything).
 *   - Rejects via `throw new ProcessorRejection(...)` — the user's
 *     `writeTransaction` rolls back atomically; no rows committed,
 *     no snapshots recorded, no undo entry created.
 *
 * Ordering: registration order (the facet preserves insertion
 * order). Single pass — same-tx processors do NOT re-fire on
 * amendments by other same-tx processors in the same pipeline pass.
 * Each processor's `changedRows` is recomputed from the live
 * snapshots before its `apply` runs, so a later processor sees an
 * earlier processor's writes; this is one-way, not fixpoint.
 *
 * Re-fire on post-commit: same as today — when a same-tx amendment
 * touches a watched field, the field-watch dispatch at the
 * post-commit stage sees the amended `after` and fires post-commit
 * processors accordingly.
 */

import type { BlockData } from './blockData'
import type { AnyPropertySchema } from './propertySchema'
import type { ChangeScope } from './changeScope'
import type { ChangedRow } from './processor'
import type { Tx } from './tx'
import type { User } from './user'

/** Plugin-augmentable registry for same-tx processor names → typed
 *  metadata. Mirrors `PostCommitProcessorRegistry` for parity even
 *  though same-tx has no `scheduledArgs` channel today. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SameTxProcessorRegistry { /* augmented per processor */ }

export type SameTxProcessor = {
  readonly name: string
  /** Same-tx processors only support `kind: 'field'` (there is no
   *  explicit / afterCommit channel — that's a post-commit-only
   *  concept since the user fn can't schedule into its own
   *  pre-commit phase). */
  readonly watches: {
    kind: 'field'
    table: 'blocks'
    fields: ReadonlyArray<keyof BlockData>
  }
  readonly apply: (event: SameTxEvent, ctx: SameTxCtx) => Promise<void>
}

export interface SameTxEvent {
  txId: string
  scope: ChangeScope
  user: User
  /** Always a string for same-tx processors — they only fire after
   *  the user fn made at least one write (otherwise the watch can't
   *  have matched), so workspace pinning is already settled. */
  workspaceId: string
  /** Rows whose staged writes touched a watched field. `before` is
   *  the pre-tx state (or null for inserts); `after` is the live
   *  staged value at the moment this processor fires (includes
   *  amendments by earlier same-tx processors in this pass). */
  changedRows: ChangedRow[]
}

export interface SameTxCtx {
  /** Active `Tx` — same handle the user fn used. Reads see staged
   *  state; writes amend the same tx. Throws here roll back the
   *  whole user tx via SQLite's `writeTransaction` abort. */
  tx: Tx
  /** Merged property-schema registry snapshotted at tx start. */
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>
}

/** Thrown by a same-tx processor to reject the user's tx. The
 *  SQLite `writeTransaction` aborts; the error bubbles out of
 *  `repo.tx` to the caller. Top-level handlers (editor save, chip
 *  edit, command palette) catch this and surface the error via the
 *  toast layer using `code` + `meta` to format the message.
 *
 *  Distinct error class so callers can `if (err instanceof
 *  ProcessorRejection)` without parsing messages. `code` is a
 *  stable string like `'alias.collision'` for routing to the right
 *  UI affordance. `meta` carries structured detail the toast can
 *  use for action buttons / formatted messages. */
export class ProcessorRejection extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly meta?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ProcessorRejection'
  }
}

export const defineSameTxProcessor = (
  processor: SameTxProcessor,
): SameTxProcessor => processor

/** Variance-erased same-tx processor type for heterogeneous
 *  collections (the engine's facet registry). Parallel to
 *  `AnyPostCommitProcessor`. */
export type AnySameTxProcessor = SameTxProcessor
