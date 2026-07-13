/** Typed errors thrown by the data layer. Callers can `instanceof`-check
 *  any of these; they all subclass `Error`. Names align with the data-layer
 *  spec (`tasks/data-layer-redesign.md` §5.3, §10.4, §4.7, §13.1). */

import type {PropertySchemaIdentityUnavailableReason} from './propertySchema'

// `name` is pinned for every subclass in the block at the BOTTOM of this file —
// a source string literal that survives production minification. We deliberately
// do NOT set it here via `new.target.name`: OXC minification strips class names,
// so at runtime that resolves to a mangled identifier (e.g. "q") and every
// data-layer error would report a garbage `name` in logs, error boundaries, and
// telemetry.
export class DataLayerError extends Error {}

// ──── Block facade / cache ────

export class BlockNotLoadedError extends DataLayerError {
  constructor(public readonly id: string) {
    super(`block ${id} is not loaded — call repo.load(${id}) first`)
  }
}

export class BlockNotFoundError extends DataLayerError {
  constructor(public readonly id: string) {
    super(`block ${id} does not exist`)
  }
}

/** Thrown by `repo.addType` / `repo.addTypeInTx` when the target block is
 *  missing or tombstoned at write time. Orchestration code that's about
 *  to fan out work based on the assumption the tag was applied wants this
 *  to throw rather than silently no-op. Callers that legitimately race
 *  against a concurrent delete (sync-apply / processor paths) can opt
 *  into the lenient `addTypeInTxLenient` entry point. */
export class BlockNotFoundForTypeError extends DataLayerError {
  constructor(
    public readonly blockId: string,
    public readonly typeId: string,
    public readonly reason: 'missing' | 'tombstoned',
  ) {
    super(
      `cannot add type ${JSON.stringify(typeId)} to block ${blockId}: ` +
      `block is ${reason}`,
    )
  }
}

// ──── Tx primitives ────

export class DuplicateIdError extends DataLayerError {
  constructor(public readonly id: string) {
    super(`block ${id} already exists`)
  }
}

export class DeletedConflictError extends DataLayerError {
  constructor(public readonly id: string) {
    super(`block ${id} is soft-deleted; restore via tx.restore or a domain helper`)
  }
}

export class DeterministicIdCrossWorkspaceError extends DataLayerError {
  constructor(
    public readonly id: string,
    public readonly existingWorkspaceId: string,
    public readonly requestedWorkspaceId: string,
  ) {
    super(
      `deterministic id ${id} resolves to workspace ${existingWorkspaceId} ` +
      `but was requested for workspace ${requestedWorkspaceId}`,
    )
  }
}

export class NotDeletedError extends DataLayerError {
  constructor(public readonly id: string) {
    super(`block ${id} is not soft-deleted; tx.restore expects a tombstone`)
  }
}

// ──── Tree / structural ────

export class CycleError extends DataLayerError {
  constructor(
    public readonly movedId: string,
    public readonly targetParentId: string,
  ) {
    super(`moving ${movedId} under ${targetParentId} would create a cycle`)
  }
}

/** Precondition failure raised by the block-merge helper when `into` is a
 *  descendant of `from`. Folding `from`'s subtree into one of its own
 *  descendants would re-home an ancestor of `into` under `into` (via
 *  `tx.move`) and trip the cycle guard mid-fold — the merge can never
 *  succeed in that direction. Surfaced up front as a typed, user-actionable
 *  error (e.g. the alias-collision "Merge into…" affordance) instead of
 *  leaking the raw `CycleError` after a partial fold + rollback (#188). */
export class MergeIntoDescendantError extends DataLayerError {
  constructor(
    public readonly intoId: string,
    public readonly fromId: string,
  ) {
    super(
      `cannot merge ${fromId} into ${intoId}: ${intoId} is a descendant of ${fromId}`,
    )
  }
}

/** Thrown by the tx engine's parent preflight when a write references a
 *  non-existent parent_id. The storage layer still backs this invariant, but
 *  its local trigger collapses missing-parent and cross-workspace failures
 *  into one SQLITE constraint message. */
export class ParentNotFoundError extends DataLayerError {
  constructor(public readonly parentId: string) {
    super(`parent block ${parentId} does not exist`)
  }
}

/** Thrown by the tx engine's parent preflight when a write places a child
 *  under a parent in a different workspace. */
export class ParentWorkspaceMismatchError extends DataLayerError {
  constructor(
    public readonly parentId: string,
    public readonly parentWorkspaceId: string,
    public readonly childWorkspaceId: string,
  ) {
    super(
      `parent ${parentId} is in workspace ${parentWorkspaceId} ` +
      `but child is in workspace ${childWorkspaceId}`,
    )
  }
}

/** Kernel-mutator UX rule (not a storage invariant): a kernel mutator
 *  preflighted the parent's `deleted` flag and refused to create or move
 *  a child under a soft-deleted parent. Plugin mutators and direct
 *  `repo.tx` callers that skip the kernel layer do not get this check. */
export class ParentDeletedError extends DataLayerError {
  constructor(public readonly parentId: string) {
    super(`parent block ${parentId} is soft-deleted`)
  }
}

// ──── Tx-level invariants ────

/** A second write inside a single repo.tx targeted a different workspace
 *  than the first write (which pinned `tx.meta.workspaceId`). */
export class WorkspaceMismatchError extends DataLayerError {
  constructor(
    public readonly pinnedWorkspaceId: string,
    public readonly attemptedWorkspaceId: string,
  ) {
    super(
      `tx pinned to workspace ${pinnedWorkspaceId}; rejected write to ${attemptedWorkspaceId}`,
    )
  }
}

/** `tx.afterCommit` was called before any write happened in the tx, so
 *  no workspace has been pinned. CommittedEvent.workspaceId would be
 *  null, which the type contract forbids. */
export class WorkspaceNotPinnedError extends DataLayerError {
  constructor() {
    super('tx.afterCommit requires a prior write so workspaceId is pinned')
  }
}

/** A property schema could not prove that it maps to the target workspace's
 * winning definition. Reads degrade at their boundary; writes surface this
 * structured error before codecs or updater callbacks run. */
export class PropertySchemaIdentityError extends DataLayerError {
  constructor(
    public readonly schemaName: string,
    public readonly reason: PropertySchemaIdentityUnavailableReason,
  ) {
    super(
      `cannot write property ${JSON.stringify(schemaName)}: ` +
      `schema identity is unavailable (${reason})`,
    )
  }
}

/** A property write whose RESOLVED change-scope differs from the scope the
 *  transaction was admitted under. The tx scope is chosen from the caller's
 *  schema; if the backing definition's change-scope was edited after the caller
 *  captured that schema, admitting the write under the stale scope would let it
 *  bypass the read-only gate and misroute its undo entry. */
export class PropertySchemaScopeMismatchError extends DataLayerError {
  constructor(
    public readonly schemaName: string,
    public readonly txScope: string,
    public readonly resolvedScope: string,
  ) {
    super(
      `cannot write property ${JSON.stringify(schemaName)}: resolved change-scope ` +
      `${resolvedScope} does not match the transaction scope ${txScope} ` +
      `(the definition's change-scope changed after the caller captured its schema)`,
    )
  }
}

// ──── Mode / dispatch ────

export class ReadOnlyError extends DataLayerError {
  constructor(public readonly scope: string) {
    super(`tx scope ${scope} is rejected in read-only mode`)
  }
}

export class MutatorNotRegisteredError extends DataLayerError {
  constructor(public readonly mutatorName: string) {
    super(`no mutator registered with name ${mutatorName}`)
  }
}

export class QueryNotRegisteredError extends DataLayerError {
  constructor(public readonly queryName: string) {
    super(`no query registered with name ${queryName}`)
  }
}

export class ProcessorNotRegisteredError extends DataLayerError {
  constructor(public readonly processorName: string) {
    super(`no post-commit processor registered with name ${processorName}`)
  }
}

// ──── Codecs ────

export class CodecError extends DataLayerError {
  constructor(
    public readonly expected: string,
    public readonly got: unknown,
  ) {
    const preview = (() => {
      try {
        const text = JSON.stringify(got)
        return text === undefined ? String(got) : text.slice(0, 80)
      } catch {
        return String(got)
      }
    })()
    super(`expected ${expected}, got ${typeof got} (${preview})`)
  }
}

// ──── Stable error names (minification-safe) ────
//
// Pin each error's `name` to a source string LITERAL. The base used to derive it
// from `new.target.name`, but production OXC minification strips class names, so
// that surfaced a mangled identifier (e.g. "q") in logs, error boundaries, and
// telemetry. The KEYS below are string literals the minifier can't touch;
// assigning on each prototype keeps this to one localized block instead of a
// `this.name = '…'` in every constructor. errors.test.ts asserts this list
// covers every exported subclass, so a new error that forgets its entry fails.
const ERROR_NAMES: ReadonlyArray<readonly [string, {prototype: object}]> = [
  ['DataLayerError', DataLayerError],
  ['BlockNotLoadedError', BlockNotLoadedError],
  ['BlockNotFoundError', BlockNotFoundError],
  ['BlockNotFoundForTypeError', BlockNotFoundForTypeError],
  ['DuplicateIdError', DuplicateIdError],
  ['DeletedConflictError', DeletedConflictError],
  ['DeterministicIdCrossWorkspaceError', DeterministicIdCrossWorkspaceError],
  ['NotDeletedError', NotDeletedError],
  ['CycleError', CycleError],
  ['MergeIntoDescendantError', MergeIntoDescendantError],
  ['ParentNotFoundError', ParentNotFoundError],
  ['ParentWorkspaceMismatchError', ParentWorkspaceMismatchError],
  ['ParentDeletedError', ParentDeletedError],
  ['WorkspaceMismatchError', WorkspaceMismatchError],
  ['WorkspaceNotPinnedError', WorkspaceNotPinnedError],
  ['PropertySchemaIdentityError', PropertySchemaIdentityError],
  ['PropertySchemaScopeMismatchError', PropertySchemaScopeMismatchError],
  ['ReadOnlyError', ReadOnlyError],
  ['MutatorNotRegisteredError', MutatorNotRegisteredError],
  ['QueryNotRegisteredError', QueryNotRegisteredError],
  ['ProcessorNotRegisteredError', ProcessorNotRegisteredError],
  ['CodecError', CodecError],
]
for (const [name, cls] of ERROR_NAMES) {
  Object.defineProperty(cls.prototype, 'name', {
    value: name,
    writable: true,
    configurable: true,
    enumerable: false,
  })
}
