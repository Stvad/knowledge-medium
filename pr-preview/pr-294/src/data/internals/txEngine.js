import { normalizeReferences } from "../api/blockData.js";
import { BlockNotFoundError, CycleError, DeletedConflictError, DeterministicIdCrossWorkspaceError, DuplicateIdError, MutatorNotRegisteredError, NotDeletedError, ParentDeletedError, ParentNotFoundError, ParentWorkspaceMismatchError, ProcessorNotRegisteredError, WorkspaceMismatchError, WorkspaceNotPinnedError } from "../api/errors.js";
import "../api/index.js";
import { BLOCK_STORAGE_COLUMNS, blockToRowParams, parseBlockRow } from "../blockSchema.js";
import { peekSnapshot, recordWrite } from "./txSnapshots.js";
import { IS_DESCENDANT_OF_SQL } from "./treeQueries.js";
import { SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL } from "./kernelQueries.js";
import { jsonValuesEqual } from "./jsonCanonical.js";
//#region src/data/internals/txEngine.ts
var updatePatchChangesBlock = (before, patch) => {
	if (patch.content !== void 0 && patch.content !== before.content) return true;
	if (patch.references !== void 0 && !jsonValuesEqual(before.references, normalizeReferences(patch.references))) return true;
	if (patch.properties !== void 0 && !jsonValuesEqual(before.properties, patch.properties)) return true;
	return false;
};
var COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map((c) => c.name);
var COLUMN_LIST = COLUMN_NAMES.join(", ");
var COLUMN_PLACEHOLDERS = COLUMN_NAMES.map(() => "?").join(", ");
var SELECT_BY_ID_SQL = `SELECT ${COLUMN_LIST} FROM blocks WHERE id = ?`;
var SELECT_CHILDREN_SQL = `SELECT ${COLUMN_LIST} FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id`;
/** Existence probes for `tx.hasChildren`. The live-only form keeps the
*  `deleted = 0` clause so it stays served by the partial
*  `idx_blocks_parent_order`; the `includeDeleted` form drops it (and so
*  cannot use that partial index — table scan), used only off hot paths
*  to detect a row that ever had children vs a never-populated stub. */
var SELECT_HAS_CHILD_SQL = `SELECT 1 AS one FROM blocks WHERE parent_id = ? AND deleted = 0 LIMIT 1`;
var SELECT_HAS_CHILD_INCLUDING_DELETED_SQL = `SELECT 1 AS one FROM blocks WHERE parent_id = ? LIMIT 1`;
/** Root-level siblings (parent_id IS NULL). When a tx has pinned a
*  workspace, scope to that workspace so `tx.childrenOf(null)` doesn't
*  spill across workspaces — important for single-workspace-per-tx
*  invariants and for sibling-position helpers like createSiblingAbove
*  on root blocks. */
var SELECT_ROOT_SIBLINGS_SQL = `SELECT ${COLUMN_LIST} FROM blocks WHERE parent_id IS NULL AND deleted = 0 AND workspace_id = ? ORDER BY order_key, id`;
var SELECT_NEXT_CHILD_SIBLING_SQL = `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id = ? AND deleted = 0
     AND (order_key > ? OR (order_key = ? AND id > ?))
   ORDER BY order_key, id
   LIMIT 1`;
var SELECT_PREVIOUS_CHILD_SIBLING_SQL = `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id = ? AND deleted = 0
     AND (order_key < ? OR (order_key = ? AND id < ?))
   ORDER BY order_key DESC, id DESC
   LIMIT 1`;
var SELECT_NEXT_ROOT_SIBLING_SQL = `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id IS NULL AND deleted = 0 AND workspace_id = ?
     AND (order_key > ? OR (order_key = ? AND id > ?))
   ORDER BY order_key, id
   LIMIT 1`;
var SELECT_PREVIOUS_ROOT_SIBLING_SQL = `SELECT ${COLUMN_LIST} FROM blocks
   WHERE parent_id IS NULL AND deleted = 0 AND workspace_id = ?
     AND (order_key < ? OR (order_key = ? AND id < ?))
   ORDER BY order_key DESC, id DESC
   LIMIT 1`;
var SELECT_PARENT_SQL = `SELECT p.* FROM blocks AS c JOIN blocks AS p ON p.id = c.parent_id WHERE c.id = ? AND p.deleted = 0`;
var SELECT_PARENT_WORKSPACE_SQL = `SELECT workspace_id, deleted FROM blocks WHERE id = ?`;
var INSERT_SQL = `INSERT INTO blocks (${COLUMN_LIST}) VALUES (${COLUMN_PLACEHOLDERS})`;
var TxImpl = class {
	meta;
	ctx;
	/** True once `meta.workspaceId` has been pinned by the first write
	*  (or first write candidate that the engine validated to insert). */
	workspacePinned = false;
	/** Ids inserted in THIS tx via a `{systemMint: true}` create/createOrGet.
	*  Same-tx follow-up writes (`update` / `setProperty` / `move` / …) to one
	*  of these HOLD `updated_at` at the `0` pristine sentinel instead of
	*  advancing it — mirrors the upload compactor's same-tx CREATE+PATCH fusion
	*  (`createTxId`), so the multi-write shaping a deterministic-id mint does
	*  (content + alias prop + type marker) uploads as a single pristine default
	*  the reconcile gate lets yield. Per-tx (the engine builds a fresh TxImpl
	*  per `repo.tx`), so it never leaks across transactions. */
	systemMintedIds = /* @__PURE__ */ new Set();
	constructor(ctx) {
		this.ctx = ctx;
		this.meta = ctx.meta;
		if (ctx.meta.workspaceId !== null) this.workspacePinned = true;
	}
	async get(id) {
		const row = await this.ctx.txDb.getOptional(SELECT_BY_ID_SQL, [id]);
		return row === null ? null : parseBlockRow(row);
	}
	peek(id) {
		const own = peekSnapshot(this.ctx.snapshots, id);
		if (own !== void 0) return own;
		return this.ctx.cache.getSnapshot(id) ?? null;
	}
	async create(data, opts) {
		this.checkWorkspace(data.workspaceId);
		await this.requireParentInWorkspace(data.parentId, data.workspaceId);
		const id = data.id ?? this.ctx.newId();
		const row = this.buildNewBlockRow(id, data, opts);
		try {
			await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(row));
		} catch (e) {
			if (isUniqueConstraint(e, "blocks.id")) throw new DuplicateIdError(id);
			throw e;
		}
		this.markSystemMint(id, opts);
		this.pinWorkspace(data.workspaceId);
		recordWrite(this.ctx.snapshots, id, null, row);
		return id;
	}
	async createOrGet(data, opts) {
		this.checkWorkspace(data.workspaceId);
		const existing = await this.ctx.txDb.getOptional(SELECT_BY_ID_SQL, [data.id]);
		if (existing === null) {
			await this.requireParentInWorkspace(data.parentId, data.workspaceId);
			const row = this.buildNewBlockRow(data.id, data, opts);
			await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(row));
			this.markSystemMint(data.id, opts);
			this.pinWorkspace(data.workspaceId);
			recordWrite(this.ctx.snapshots, data.id, null, row);
			return {
				id: data.id,
				inserted: true
			};
		}
		if (existing.workspace_id !== data.workspaceId) throw new DeterministicIdCrossWorkspaceError(data.id, existing.workspace_id, data.workspaceId);
		if (existing.deleted === 1) throw new DeletedConflictError(data.id);
		return {
			id: data.id,
			inserted: false
		};
	}
	async delete(id) {
		const before = await this.requireExisting(id);
		this.checkWorkspace(before.workspaceId);
		if (before.deleted) return;
		const after = {
			...before,
			deleted: true,
			...this.metadataPatch(id, before, false)
		};
		await this.ctx.txDb.execute(`UPDATE blocks SET deleted = 1, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`, [
			after.updatedAt,
			after.userUpdatedAt,
			after.updatedBy,
			id
		]);
		this.pinWorkspace(before.workspaceId);
		recordWrite(this.ctx.snapshots, id, before, after);
	}
	async restore(id, patch, opts) {
		const before = await this.ctx.txDb.getOptional(SELECT_BY_ID_SQL, [id]);
		if (before === null) throw new BlockNotFoundError(id);
		if (before.deleted === 0) throw new NotDeletedError(id);
		const beforeData = parseBlockRow(before);
		this.checkWorkspace(beforeData.workspaceId);
		const after = {
			...beforeData,
			deleted: false,
			...patch?.content !== void 0 ? { content: patch.content } : {},
			...patch?.references !== void 0 ? { references: patch.references } : {},
			...patch?.properties !== void 0 ? { properties: patch.properties } : {},
			...this.metadataPatch(id, beforeData, opts?.skipMetadata)
		};
		await this.ctx.txDb.execute(`UPDATE blocks SET deleted = 0, content = ?, references_json = ?, properties_json = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`, [
			after.content,
			JSON.stringify(after.references),
			JSON.stringify(after.properties),
			after.updatedAt,
			after.userUpdatedAt,
			after.updatedBy,
			id
		]);
		this.pinWorkspace(beforeData.workspaceId);
		recordWrite(this.ctx.snapshots, id, beforeData, after);
	}
	async update(id, patch, opts) {
		const before = await this.requireExisting(id);
		this.checkWorkspace(before.workspaceId);
		if (!updatePatchChangesBlock(before, patch)) return;
		const after = {
			...before,
			...patch.content !== void 0 ? { content: patch.content } : {},
			...patch.references !== void 0 ? { references: patch.references } : {},
			...patch.properties !== void 0 ? { properties: patch.properties } : {},
			...this.metadataPatch(id, before, opts?.skipMetadata)
		};
		await this.ctx.txDb.execute(`UPDATE blocks SET content = ?, references_json = ?, properties_json = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`, [
			after.content,
			JSON.stringify(after.references),
			JSON.stringify(after.properties),
			after.updatedAt,
			after.userUpdatedAt,
			after.updatedBy,
			id
		]);
		this.pinWorkspace(before.workspaceId);
		recordWrite(this.ctx.snapshots, id, before, after);
	}
	async move(id, target, opts) {
		const before = await this.requireExisting(id);
		this.checkWorkspace(before.workspaceId);
		const parent = await this.requireParentInWorkspace(target.parentId, before.workspaceId);
		if (target.parentId === before.parentId && target.orderKey === before.orderKey) return;
		if (!before.deleted && target.parentId !== null && parent?.deleted) throw new ParentDeletedError(target.parentId);
		if (target.parentId !== null && target.parentId !== before.parentId && target.parentId !== id) {
			if (await this.isDescendantOf(target.parentId, id)) throw new CycleError(id, target.parentId);
		} else if (target.parentId === id) throw new CycleError(id, id);
		const after = {
			...before,
			parentId: target.parentId,
			orderKey: target.orderKey,
			...this.metadataPatch(id, before, opts?.skipMetadata)
		};
		await this.ctx.txDb.execute(`UPDATE blocks SET parent_id = ?, order_key = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`, [
			target.parentId,
			target.orderKey,
			after.updatedAt,
			after.userUpdatedAt,
			after.updatedBy,
			id
		]);
		this.pinWorkspace(before.workspaceId);
		recordWrite(this.ctx.snapshots, id, before, after);
	}
	async setProperty(id, schema, value, opts) {
		const before = await this.requireExisting(id);
		this.checkWorkspace(before.workspaceId);
		const encoded = schema.codec.encode(value);
		if (jsonValuesEqual(before.properties[schema.name], encoded)) return;
		const properties = {
			...before.properties,
			[schema.name]: encoded
		};
		const after = {
			...before,
			properties,
			...this.metadataPatch(id, before, opts?.skipMetadata)
		};
		await this.ctx.txDb.execute(`UPDATE blocks SET properties_json = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`, [
			JSON.stringify(properties),
			after.updatedAt,
			after.userUpdatedAt,
			after.updatedBy,
			id
		]);
		this.pinWorkspace(before.workspaceId);
		recordWrite(this.ctx.snapshots, id, before, after);
	}
	async getProperty(id, schema) {
		const row = await this.ctx.txDb.getOptional(SELECT_BY_ID_SQL, [id]);
		if (row === null) throw new BlockNotFoundError(id);
		const stored = parseBlockRow(row).properties[schema.name];
		if (stored === void 0) return schema.defaultValue;
		return schema.codec.decode(stored);
	}
	async run(mutator, args) {
		const registered = this.ctx.mutators.get(mutator.name);
		if (registered === void 0) throw new MutatorNotRegisteredError(mutator.name);
		const subScope = typeof registered.scope === "function" ? registered.scope(args) : registered.scope;
		if (subScope !== this.meta.scope) throw new Error(`tx.run scope mismatch: tx is "${this.meta.scope}", mutator "${mutator.name}" requires "${subScope}"`);
		this.ctx.mutatorCalls.push({
			name: mutator.name,
			args
		});
		return await registered.apply(this, args);
	}
	async childrenOf(parentId, workspaceId) {
		if (parentId === null) {
			const ws = workspaceId ?? (this.workspacePinned ? this.meta.workspaceId : null);
			if (ws === null) throw new WorkspaceNotPinnedError();
			return (await this.ctx.txDb.getAll(SELECT_ROOT_SIBLINGS_SQL, [ws])).map(parseBlockRow);
		}
		return (await this.ctx.txDb.getAll(SELECT_CHILDREN_SQL, [parentId])).map(parseBlockRow);
	}
	async hasChildren(parentId, opts) {
		const sql = opts?.includeDeleted ? SELECT_HAS_CHILD_INCLUDING_DELETED_SQL : SELECT_HAS_CHILD_SQL;
		return await this.ctx.txDb.getOptional(sql, [parentId]) !== null;
	}
	async adjacentSibling(anchor, direction) {
		const params = anchor.parentId === null ? [
			anchor.workspaceId,
			anchor.orderKey,
			anchor.orderKey,
			anchor.id
		] : [
			anchor.parentId,
			anchor.orderKey,
			anchor.orderKey,
			anchor.id
		];
		const sql = anchor.parentId === null ? direction === "after" ? SELECT_NEXT_ROOT_SIBLING_SQL : SELECT_PREVIOUS_ROOT_SIBLING_SQL : direction === "after" ? SELECT_NEXT_CHILD_SIBLING_SQL : SELECT_PREVIOUS_CHILD_SIBLING_SQL;
		const row = await this.ctx.txDb.getOptional(sql, params);
		return row === null ? null : parseBlockRow(row);
	}
	async parentOf(childId) {
		const row = await this.ctx.txDb.getOptional(SELECT_PARENT_SQL, [childId]);
		return row === null ? null : parseBlockRow(row);
	}
	async isDescendantOf(id, potentialAncestorId) {
		return await this.ctx.txDb.getOptional(IS_DESCENDANT_OF_SQL, [id, potentialAncestorId]) !== null;
	}
	async aliasLookup(alias, workspaceId) {
		if (alias === "" || workspaceId === "") return null;
		const row = await this.ctx.txDb.getOptional(SELECT_BLOCK_BY_ALIAS_IN_WORKSPACE_SQL, [workspaceId, alias]);
		return row === null ? null : parseBlockRow(row);
	}
	afterCommit(processorName, args, options) {
		if (!this.workspacePinned) throw new WorkspaceNotPinnedError();
		const processor = this.ctx.processors.get(processorName);
		if (processor === void 0) throw new ProcessorNotRegisteredError(processorName);
		if (processor.watches.kind !== "explicit") throw new Error(`tx.afterCommit("${processorName}") — processor watches.kind = "${processor.watches.kind}"; only "explicit" processors accept scheduled jobs`);
		const validatedArgs = processor.scheduledArgsSchema.parse(args);
		this.ctx.afterCommitJobs.push({
			processorName,
			args: validatedArgs,
			delayMs: options?.delayMs
		});
	}
	emitEvent(name, payload) {
		if (!this.workspacePinned) throw new WorkspaceNotPinnedError();
		this.ctx.sameTxEvents.push({
			name,
			payload
		});
	}
	/** Drive the row at `id` to exactly `target` (or soft-delete if target
	*  is null). Bypasses the public primitives — intentionally — because
	*  undo replay restores arbitrary snapshot state that the narrow patch
	*  shape of `tx.update` can't express (e.g. `parent_id` + `order_key`
	*  + `deleted` flipping in one write). Spec §10 step 7 + the
	*  BlockDataPatch comment in `api/blockData.ts`.
	*
	*  Cycle / parent-deleted UX checks are skipped: the snapshot was
	*  captured from a previously-committed tx, so the target state is
	*  known to be valid (the engine validated it then). The
	*  workspace-invariant trigger still fires on UPDATE-of-parent_id, so
	*  the storage-level guarantee holds. `updatedAt` / `updatedBy` are
	*  stamped to the replay tx's user + now() — a redo at 10:01 by user
	*  B is correctly attributed to B@10:01, not the original write.
	*
	*  Captures `(currentRow, applied)` into the snapshots map so the
	*  pipeline's commit-walk updates the cache and fires handles for the
	*  rolled-back row.
	*
	*  Exactness depends on the commit pipeline SKIPPING its same-tx
	*  processor pass for replay txs (`runTx`'s `isReplay`, threaded from
	*  `Repo._replay`). `applyRaw`'s write is still a field change in the
	*  replay tx, so without that gate a value-deriving same-tx processor
	*  would re-derive and override the restore — leaving the row at a
	*  derived value, not `target` (#187). */
	async applyRaw(id, target) {
		const beforeRow = await this.ctx.txDb.getOptional(SELECT_BY_ID_SQL, [id]);
		const beforeData = beforeRow === null ? null : parseBlockRow(beforeRow);
		const now = this.ctx.now();
		const userId = this.meta.user.id;
		if (target === null) {
			if (beforeData === null || beforeData.deleted) return;
			const after = {
				...beforeData,
				deleted: true,
				updatedAt: Math.max(now, beforeData.updatedAt + 1),
				userUpdatedAt: now,
				updatedBy: userId
			};
			await this.ctx.txDb.execute(`UPDATE blocks SET deleted = 1, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`, [
				after.updatedAt,
				now,
				userId,
				id
			]);
			this.pinWorkspace(beforeData.workspaceId);
			recordWrite(this.ctx.snapshots, id, beforeData, after);
			return;
		}
		if (beforeData === null) {
			const inserted = {
				...target,
				updatedAt: now,
				userUpdatedAt: now,
				updatedBy: userId
			};
			await this.ctx.txDb.execute(INSERT_SQL, blockToRowParams(inserted));
			this.pinWorkspace(target.workspaceId);
			recordWrite(this.ctx.snapshots, id, null, inserted);
			return;
		}
		const after = {
			...target,
			updatedAt: Math.max(now, beforeData.updatedAt + 1),
			userUpdatedAt: now,
			updatedBy: userId
		};
		await this.ctx.txDb.execute(`UPDATE blocks SET parent_id = ?, order_key = ?, content = ?, properties_json = ?, references_json = ?, deleted = ?, updated_at = ?, user_updated_at = ?, updated_by = ? WHERE id = ?`, [
			target.parentId,
			target.orderKey,
			target.content,
			JSON.stringify(target.properties),
			JSON.stringify(target.references),
			target.deleted ? 1 : 0,
			after.updatedAt,
			now,
			userId,
			id
		]);
		this.pinWorkspace(beforeData.workspaceId);
		recordWrite(this.ctx.snapshots, id, beforeData, after);
	}
	/** Validate that a write to `workspaceId` is allowed in this tx.
	*  Pre-pin (no writes yet) anything goes. Post-pin, must match. */
	checkWorkspace(workspaceId) {
		if (this.workspacePinned && this.meta.workspaceId !== workspaceId) throw new WorkspaceMismatchError(this.meta.workspaceId, workspaceId);
	}
	/** Pin the tx's workspace_id from the first successful primitive.
	*  Idempotent. Mutates `this.meta` so external readers see the pin. */
	pinWorkspace(workspaceId) {
		if (this.workspacePinned) return;
		this.meta.workspaceId = workspaceId;
		this.workspacePinned = true;
	}
	/** Record that `id` was just system-minted in this tx, so same-tx
	*  follow-up shaping writes (`setProperty` / `addTypeInTx` / …) keep its
	*  `updated_at` pinned at the `0` pristine sentinel instead of advancing it
	*  (see `metadataPatch` and `systemMintedIds`). Without this, the same-tx
	*  shaping a deterministic-id mint does — and the upload compactor's
	*  PUT+PATCH fusion — would overwrite the `0`, so the sentinel the reconcile
	*  gate lets yield to the server would never exist. No-op unless
	*  `opts.systemMint` — and `systemMint` is insert-only at the type level
	*  ({@link TxInsertOpts}), so this is only ever reached from
	*  `create` / `createOrGet`. */
	markSystemMint(id, opts) {
		if (opts?.systemMint) this.systemMintedIds.add(id);
	}
	/** Metadata stamps for a content-changing write to `id`.
	*  - `updatedAt` (the row-version / sync-gate discriminator) ALWAYS advances
	*    and is locally monotonic (invariant I3): `max(now, before.updatedAt + 1)`,
	*    so a fresh local edit can never stamp at or below the row's current
	*    version even when the server has ratcheted ahead of this device's clock.
	*    EXCEPT ids system-minted in THIS tx, held at the `0` pristine sentinel
	*    (see `markSystemMint`).
	*  - `userUpdatedAt` (display) + `updatedBy` advance only on a real user
	*    edit; a `{skipMetadata}` bookkeeping write leaves them untouched while
	*    still advancing `updatedAt`. `updatedBy` is now a plain user-pair field
	*    (no `system:` prefix) — the gate reads `updatedAt === 0` for pristineness. */
	metadataPatch(id, before, skipMetadata) {
		const now = this.ctx.now();
		const updatedAt = this.systemMintedIds.has(id) ? 0 : Math.max(now, before.updatedAt + 1);
		if (skipMetadata) return { updatedAt };
		return {
			updatedAt,
			userUpdatedAt: now,
			updatedBy: this.meta.user.id
		};
	}
	/** Build a fresh BlockData for `tx.create` / `tx.createOrGet` insert
	*  paths. Engine sets all metadata columns from tx_context unless
	*  `opts.skipMetadata` (used only by bookkeeping writes).
	*
	*  `opts.systemMint` marks the row as a speculative default the reconcile
	*  gate can let yield: it stamps `updated_at = 0` (the pristine sentinel the
	*  gate's stamp-0 exemption recognizes), while `created_by` / `updated_by`
	*  stay the REAL user — authorship is no longer the discriminator (the gate
	*  reads `updated_at === 0`, not a `system:` prefix). The first real edit in
	*  a later tx ratchets `updated_at` off 0 via `metadataPatch`'s I3 floor. */
	buildNewBlockRow(id, data, opts) {
		const now = this.ctx.now();
		const userId = this.meta.user.id;
		const updatedAt = opts?.skipMetadata || opts?.systemMint ? 0 : now;
		const source = opts?.skipMetadata ? void 0 : opts?.sourceTimestamps;
		const createdAt = opts?.skipMetadata ? 0 : source?.createdAt ?? now;
		const createdBy = opts?.skipMetadata ? "" : userId;
		const updatedBy = opts?.skipMetadata ? "" : userId;
		return {
			id,
			workspaceId: data.workspaceId,
			parentId: data.parentId,
			orderKey: data.orderKey,
			content: data.content ?? "",
			properties: data.properties ?? {},
			references: data.references ?? [],
			createdAt,
			updatedAt,
			userUpdatedAt: source?.userUpdatedAt ?? now,
			createdBy,
			updatedBy,
			deleted: false
		};
	}
	async requireExisting(id) {
		const ownWrite = peekSnapshot(this.ctx.snapshots, id);
		if (ownWrite !== void 0) {
			if (ownWrite === null) throw new BlockNotFoundError(id);
			return ownWrite;
		}
		const row = await this.ctx.txDb.getOptional(SELECT_BY_ID_SQL, [id]);
		if (row === null) throw new BlockNotFoundError(id);
		return parseBlockRow(row);
	}
	async requireParentInWorkspace(parentId, childWorkspaceId) {
		if (parentId === null) return null;
		const parent = await this.ctx.txDb.getOptional(SELECT_PARENT_WORKSPACE_SQL, [parentId]);
		if (parent === null) throw new ParentNotFoundError(parentId);
		if (parent.workspace_id !== childWorkspaceId) throw new ParentWorkspaceMismatchError(parentId, parent.workspace_id, childWorkspaceId);
		return { deleted: parent.deleted === 1 };
	}
};
/** Detect SQLite UNIQUE-constraint failures on `blocks.id`. SQLite's
*  error messages embed the column name, so a string-match is the
*  reliable signal in practice. The shape `'UNIQUE constraint failed:
*  blocks.id'` covers the SQLite C error and the better-sqlite3 wrapper
*  thereof. */
var isUniqueConstraint = (e, columnFqn) => {
	if (e === null || typeof e !== "object") return false;
	const msg = e.message;
	return typeof msg === "string" && msg.includes(`UNIQUE constraint failed: ${columnFqn}`);
};
/** Build the initial `meta` for a tx — used by the pipeline at the
*  start of `repo.tx`. The workspaceId starts null; the first write
*  primitive pins it. */
var newTxMeta = (params) => ({
	txId: params.txId,
	scope: params.scope,
	source: params.source,
	user: params.user,
	description: params.description,
	workspaceId: null
});
//#endregion
export { TxImpl, newTxMeta };

//# sourceMappingURL=txEngine.js.map