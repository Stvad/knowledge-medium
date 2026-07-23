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
 * reference-array normalization and alias sync (content↔aliases
 * reconciliation + alias-collision rejection). Latency added here is
 * paid by the user-commit path, so it has to stay cheap.
 *
 * What same-tx is NOT for: hot-path expensive enrichment
 * (parseReferences), typing-time cross-row writes (rename rewriting
 * backlinks across many sources), delayed cleanup. Those stay
 * post-commit per §7.1. Rare correctness-critical domain events
 * (e.g. merge retargeting) may still use same-tx when atomicity is
 * worth the extra commit cost.
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
import type { AnyPropertySchema, PropertySchemaResolution } from './propertySchema'
import type { ChangeScope } from './changeScope'
import type { ChangedRow } from './processor'
import type { Tx } from './tx'
import type { User } from './user'

/** Plugin-augmentable registry for same-tx domain event names → typed
 *  payloads. Event emitters augment this from the module that owns the
 *  event; processors consume the typed payload via `tx.emitEvent`.
 *  Dynamic plugins can still emit unknown events and rely on runtime
 *  validation inside their processors. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface SameTxEventRegistry { /* augmented per event */ }

export type SameTxEventPayload<P extends string> =
  P extends keyof SameTxEventRegistry
    ? SameTxEventRegistry[P]
    : unknown

export interface SameTxEmittedEvent<Name extends string = string, Payload = unknown> {
  name: Name
  payload: Payload
}

/** Read-only SQL surface available to same-tx processors inside the
 *  active writeTransaction. This is intentionally narrow: plugins can
 *  read their own local indexes with read-your-own-writes semantics, but
 *  writes still go through `ctx.tx` so snapshots, row_events, undo, and
 *  metadata stay coherent. */
export interface SameTxReadDb {
  getOptional<T>(sql: string, params?: unknown[]): Promise<T | null>
  getAll<T>(sql: string, params?: unknown[]): Promise<T[]>
  get<T>(sql: string, params?: unknown[]): Promise<T>
}

export type SameTxProcessor = {
  readonly name: string
  /** Same-tx processors can either watch block field changes or watch
   *  explicit domain events emitted by a tx. Event watches are not
   *  durable post-commit jobs; they run in the same pre-commit pass and
   *  roll back with the originating tx. */
  readonly watches:
    | {
        kind: 'field'
        table: 'blocks'
        fields: ReadonlyArray<keyof BlockData>
      }
    | {
        kind: 'event'
        events: ReadonlyArray<string>
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
  /** Tx-emitted domain events matching this processor's event watch.
   *  Empty for field-watch processors. */
  emittedEvents: SameTxEmittedEvent[]
}

export interface SameTxCtx {
  /** Active `Tx` — same handle the user fn used. Reads see staged
   *  state; writes amend the same tx. Throws here roll back the
   *  whole user tx via SQLite's `writeTransaction` abort. */
  tx: Tx
  /** Read-only active-transaction SQL surface. Use this for plugin-owned
   *  projection tables that must be queried atomically with tx writes. */
  db: SameTxReadDb
  /** Merged property-schema registry snapshotted at tx start. */
  propertySchemas: ReadonlyMap<string, AnyPropertySchema>
  /** Resolve a property-schema NAME against `workspaceId`'s deterministic
   *  fleet-wide winner map — the same tx-start-captured identity primitive
   *  `tx.setProperty` resolves through (schema unification §7). `resolved`
   *  carries the branded `ResolvedPropertySchema` (with `fieldId`);
   *  shadowed/ambiguous names come back as a structured
   *  `identity-unavailable`, never a per-client guess. Synchronous — pure
   *  snapshot lookups. */
  resolvePropertySchemaName(
    workspaceId: string,
    name: string,
  ): PropertySchemaResolution<unknown>
  /** Resolve a durable fieldId (definition block id) against the same
   *  snapshot — the recognition primitive for field rows
   *  (`reference_target_id` → schema). Shadowed definitions resolve as
   *  `identity-unavailable` with reason 'shadowed' (their field rows keep
   *  classifying at read sites, but they are excluded from the name map
   *  and cell projection — unification §7). */
  resolvePropertySchemaField(
    workspaceId: string,
    fieldId: string,
  ): PropertySchemaResolution<unknown>
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
