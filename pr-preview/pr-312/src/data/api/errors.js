//#region src/data/api/errors.ts
/** Typed errors thrown by the data layer. Callers can `instanceof`-check
*  any of these; they all subclass `Error`. Names align with the data-layer
*  spec (`tasks/data-layer-redesign.md` §5.3, §10.4, §4.7, §13.1). */
var DataLayerError = class extends Error {
	constructor(message) {
		super(message);
		this.name = new.target.name;
	}
};
var BlockNotLoadedError = class extends DataLayerError {
	constructor(id) {
		super(`block ${id} is not loaded — call repo.load(${id}) first`);
		this.id = id;
	}
};
var BlockNotFoundError = class extends DataLayerError {
	constructor(id) {
		super(`block ${id} does not exist`);
		this.id = id;
	}
};
/** Thrown by `repo.addType` / `repo.addTypeInTx` when the target block is
*  missing or tombstoned at write time. Orchestration code that's about
*  to fan out work based on the assumption the tag was applied wants this
*  to throw rather than silently no-op. Callers that legitimately race
*  against a concurrent delete (sync-apply / processor paths) can opt
*  into the lenient `addTypeInTxLenient` entry point. */
var BlockNotFoundForTypeError = class extends DataLayerError {
	constructor(blockId, typeId, reason) {
		super(`cannot add type ${JSON.stringify(typeId)} to block ${blockId}: block is ${reason}`);
		this.blockId = blockId;
		this.typeId = typeId;
		this.reason = reason;
	}
};
var DuplicateIdError = class extends DataLayerError {
	constructor(id) {
		super(`block ${id} already exists`);
		this.id = id;
	}
};
var DeletedConflictError = class extends DataLayerError {
	constructor(id) {
		super(`block ${id} is soft-deleted; restore via tx.restore or a domain helper`);
		this.id = id;
	}
};
var DeterministicIdCrossWorkspaceError = class extends DataLayerError {
	constructor(id, existingWorkspaceId, requestedWorkspaceId) {
		super(`deterministic id ${id} resolves to workspace ${existingWorkspaceId} but was requested for workspace ${requestedWorkspaceId}`);
		this.id = id;
		this.existingWorkspaceId = existingWorkspaceId;
		this.requestedWorkspaceId = requestedWorkspaceId;
	}
};
var NotDeletedError = class extends DataLayerError {
	constructor(id) {
		super(`block ${id} is not soft-deleted; tx.restore expects a tombstone`);
		this.id = id;
	}
};
var CycleError = class extends DataLayerError {
	constructor(movedId, targetParentId) {
		super(`moving ${movedId} under ${targetParentId} would create a cycle`);
		this.movedId = movedId;
		this.targetParentId = targetParentId;
	}
};
/** Precondition failure raised by the block-merge helper when `into` is a
*  descendant of `from`. Folding `from`'s subtree into one of its own
*  descendants would re-home an ancestor of `into` under `into` (via
*  `tx.move`) and trip the cycle guard mid-fold — the merge can never
*  succeed in that direction. Surfaced up front as a typed, user-actionable
*  error (e.g. the alias-collision "Merge into…" affordance) instead of
*  leaking the raw `CycleError` after a partial fold + rollback (#188). */
var MergeIntoDescendantError = class extends DataLayerError {
	constructor(intoId, fromId) {
		super(`cannot merge ${fromId} into ${intoId}: ${intoId} is a descendant of ${fromId}`);
		this.intoId = intoId;
		this.fromId = fromId;
	}
};
/** Thrown by the tx engine's parent preflight when a write references a
*  non-existent parent_id. The storage layer still backs this invariant, but
*  its local trigger collapses missing-parent and cross-workspace failures
*  into one SQLITE constraint message. */
var ParentNotFoundError = class extends DataLayerError {
	constructor(parentId) {
		super(`parent block ${parentId} does not exist`);
		this.parentId = parentId;
	}
};
/** Thrown by the tx engine's parent preflight when a write places a child
*  under a parent in a different workspace. */
var ParentWorkspaceMismatchError = class extends DataLayerError {
	constructor(parentId, parentWorkspaceId, childWorkspaceId) {
		super(`parent ${parentId} is in workspace ${parentWorkspaceId} but child is in workspace ${childWorkspaceId}`);
		this.parentId = parentId;
		this.parentWorkspaceId = parentWorkspaceId;
		this.childWorkspaceId = childWorkspaceId;
	}
};
/** Kernel-mutator UX rule (not a storage invariant): a kernel mutator
*  preflighted the parent's `deleted` flag and refused to create or move
*  a child under a soft-deleted parent. Plugin mutators and direct
*  `repo.tx` callers that skip the kernel layer do not get this check. */
var ParentDeletedError = class extends DataLayerError {
	constructor(parentId) {
		super(`parent block ${parentId} is soft-deleted`);
		this.parentId = parentId;
	}
};
/** A second write inside a single repo.tx targeted a different workspace
*  than the first write (which pinned `tx.meta.workspaceId`). */
var WorkspaceMismatchError = class extends DataLayerError {
	constructor(pinnedWorkspaceId, attemptedWorkspaceId) {
		super(`tx pinned to workspace ${pinnedWorkspaceId}; rejected write to ${attemptedWorkspaceId}`);
		this.pinnedWorkspaceId = pinnedWorkspaceId;
		this.attemptedWorkspaceId = attemptedWorkspaceId;
	}
};
/** `tx.afterCommit` was called before any write happened in the tx, so
*  no workspace has been pinned. CommittedEvent.workspaceId would be
*  null, which the type contract forbids. */
var WorkspaceNotPinnedError = class extends DataLayerError {
	constructor() {
		super("tx.afterCommit requires a prior write so workspaceId is pinned");
	}
};
var ReadOnlyError = class extends DataLayerError {
	constructor(scope) {
		super(`tx scope ${scope} is rejected in read-only mode`);
		this.scope = scope;
	}
};
var MutatorNotRegisteredError = class extends DataLayerError {
	constructor(mutatorName) {
		super(`no mutator registered with name ${mutatorName}`);
		this.mutatorName = mutatorName;
	}
};
var QueryNotRegisteredError = class extends DataLayerError {
	constructor(queryName) {
		super(`no query registered with name ${queryName}`);
		this.queryName = queryName;
	}
};
var ProcessorNotRegisteredError = class extends DataLayerError {
	constructor(processorName) {
		super(`no post-commit processor registered with name ${processorName}`);
		this.processorName = processorName;
	}
};
var CodecError = class extends DataLayerError {
	constructor(expected, got) {
		const preview = (() => {
			try {
				const text = JSON.stringify(got);
				return text === void 0 ? String(got) : text.slice(0, 80);
			} catch {
				return String(got);
			}
		})();
		super(`expected ${expected}, got ${typeof got} (${preview})`);
		this.expected = expected;
		this.got = got;
	}
};
//#endregion
export { BlockNotFoundError, BlockNotFoundForTypeError, BlockNotLoadedError, CodecError, CycleError, DataLayerError, DeletedConflictError, DeterministicIdCrossWorkspaceError, DuplicateIdError, MergeIntoDescendantError, MutatorNotRegisteredError, NotDeletedError, ParentDeletedError, ParentNotFoundError, ParentWorkspaceMismatchError, ProcessorNotRegisteredError, QueryNotRegisteredError, ReadOnlyError, WorkspaceMismatchError, WorkspaceNotPinnedError };

//# sourceMappingURL=errors.js.map