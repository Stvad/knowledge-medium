/** Typed errors thrown by the data layer. Callers can `instanceof`-check
 *  any of these; they all subclass `Error`. Names align with the data-layer
 *  spec (`tasks/data-layer-redesign.md` §5.3, §10.4, §4.7, §13.1). */

export class DataLayerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = new.target.name
  }
}

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
