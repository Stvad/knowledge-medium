import chunk from "../../node_modules/lodash-es/chunk.js";
import { UpdateType } from "../../node_modules/@powersync/common/dist/bundle.js";
import { encryptUploadColumns } from "../sync/transform.js";
import { hasSupabaseAuthConfig, readPersistedSession, supabase } from "./supabase.js";
import { classifyUploadError } from "./uploadErrorClassifier.js";
//#region src/services/powersync.ts
var powerSyncUrl = "https://69f28626fe1b03b656a3b6b3.powersync.journeyapps.com"?.trim();
var MAX_CRUD_ENTRIES_PER_UPLOAD_BATCH = 1e4;
var MAX_TRANSACTIONS_PER_UPLOAD_BATCH = 25;
var MAX_BLOCKS_PER_SUPABASE_UPSERT = 500;
var hasRemoteSyncConfig = hasSupabaseAuthConfig && Boolean(powerSyncUrl);
/** Seal the content columns of each create/patch op whose workspace is e2ee,
*  before they reach the wire (§9.2). Deletes and plaintext workspaces pass
*  through untouched. `workspace_id` is read off the payload (always present
*  per the upload trigger, D-3.1); an op missing it can't be e2ee-routed and
*  passes through — a genuine e2ee plaintext write would be rejected by the
*  server-side ciphertext trigger rather than silently stored. */
var encryptUploadOps = async (ops, getMode, getCek) => {
	const modeByWs = /* @__PURE__ */ new Map();
	const resolveMode = async (workspaceId) => {
		const cached = modeByWs.get(workspaceId);
		if (cached !== void 0) return cached;
		const resolved = await getMode(workspaceId);
		modeByWs.set(workspaceId, resolved);
		return resolved;
	};
	const out = [];
	for (const op of ops) {
		if (op.kind === "delete") {
			out.push(op);
			continue;
		}
		const workspaceId = op.payload.workspace_id;
		if (typeof workspaceId !== "string") {
			out.push(op);
			continue;
		}
		const mode = await resolveMode(workspaceId);
		if (mode === "none") {
			out.push(op);
			continue;
		}
		const payload = await encryptUploadColumns(op.id, workspaceId, op.payload, mode, getCek);
		out.push(op.kind === "create" ? {
			...op,
			payload
		} : {
			...op,
			payload
		});
	}
	return out;
};
var defaultGetWorkspaceMode = () => "none";
var defaultUploadGetCek = async () => null;
var assertSupabase = () => {
	if (!supabase) throw new Error("Supabase is not configured");
	return supabase;
};
/** Re-throw a Supabase/PostgREST error with the HTTP `status` attached.
*
*  PostgREST returns the HTTP status as a SIBLING of `{error}` in the
*  response tuple — it is never a field on the `PostgrestError` object
*  (which carries only `{message, details, hint, code}`). The upload-error
*  classifier keys its 4xx handling off `err.status`, so unless the status is
*  threaded onto the thrown error that handling is dead: a codeless 4xx (a
*  generic 400, a 413, or any non-JSON body postgrest-js surfaces as
*  `{message: body}` with no `code`) would fall through to `transient` and
*  PowerSync would retry the same batch forever — the original queue jam. With
*  the status attached, the classifier routes a non-retryable 4xx to
*  `ambiguous` (bounded retry, then quarantine) and keeps the retryable subset
*  (401/403/408/429) transient. See `uploadErrorClassifier.ts` and issue #190. */
var throwWithHttpStatus = (error, status) => {
	throw Object.assign(error, { status });
};
var blockPayloadFromPut = (entry) => ({
	...entry.opData ?? {},
	id: entry.id
});
var compactBlockCrudEntries = (entries) => {
	const byId = /* @__PURE__ */ new Map();
	for (const [order, entry] of entries.entries()) {
		if (entry.table !== "blocks") throw new Error(`Unsupported table in upload queue: ${entry.table}`);
		const existing = byId.get(entry.id);
		if (entry.op === UpdateType.PUT) {
			byId.set(entry.id, {
				id: entry.id,
				order,
				create: blockPayloadFromPut(entry),
				createTxId: entry.transactionId
			});
			continue;
		}
		if (entry.op === UpdateType.PATCH) {
			const patchData = entry.opData ?? {};
			if (existing?.deleted) continue;
			if (existing?.create && existing.createTxId !== void 0 && existing.createTxId === entry.transactionId) {
				byId.set(entry.id, {
					...existing,
					create: {
						...existing.create,
						...patchData
					}
				});
				continue;
			}
			byId.set(entry.id, {
				id: entry.id,
				order: existing?.order ?? order,
				create: existing?.create,
				createTxId: existing?.createTxId,
				patch: existing?.patch ? {
					...existing.patch,
					...patchData
				} : patchData
			});
			continue;
		}
		if (entry.op === UpdateType.DELETE) {
			byId.set(entry.id, {
				id: entry.id,
				order,
				deleted: true
			});
			continue;
		}
		throw new Error(`Unsupported CRUD operation: ${entry.op}`);
	}
	const operations = [];
	for (const state of byId.values()) {
		if (state.deleted) {
			operations.push({
				kind: "delete",
				id: state.id,
				order: state.order
			});
			continue;
		}
		if (state.create) operations.push({
			kind: "create",
			id: state.id,
			payload: state.create,
			order: state.order
		});
		if (state.patch) operations.push({
			kind: "patch",
			id: state.id,
			payload: state.patch,
			order: state.order
		});
	}
	return operations.sort((left, right) => left.order - right.order);
};
var orderedBlockUpserts = (rows) => {
	const byId = new Map(rows.map((row) => [row.id, row]));
	const state = /* @__PURE__ */ new Map();
	const ordered = [];
	const visit = (row) => {
		const current = state.get(row.id);
		if (current === "visited") return;
		if (current === "visiting") return;
		state.set(row.id, "visiting");
		const parentId = typeof row.parent_id === "string" ? row.parent_id : null;
		const parent = parentId ? byId.get(parentId) : void 0;
		if (parent) visit(parent);
		state.set(row.id, "visited");
		ordered.push(row);
	};
	for (const row of rows) visit(row);
	return ordered;
};
/** Ships every PATCH in the compacted batch as a single
*  `apply_block_patches` RPC call. The server-side function loops the
*  patches array and runs one column-narrow UPDATE per element, with the
*  same semantics PostgREST `.update()` gave us before — just packed into
*  one HTTP round trip instead of N. Per-key `properties_json` merge is
*  out of scope here (see #51); each patch in the array writes its
*  specified columns to its specified row id.
*
*  Server-missing rows raise SQLSTATE `P0002` inside the RPC, which
*  rolls back the function's transaction so partial sibling UPDATEs do
*  not commit. PostgREST surfaces the SQLSTATE on the error's `code`
*  field; `uploadErrorClassifier` classifies it as permanent and the
*  orchestrator's per-tx fallback (`uploadTransactionsWithFallback`)
*  quarantines that single tx. */
var applyBlockPatchesRpc = async (patches) => {
	if (patches.length === 0) return;
	const client = assertSupabase();
	for (const batch of chunk(patches, 500)) {
		console.debug("[powersync] PATCH batch", batch.length);
		const payload = batch.map((patch) => ({
			id: patch.id,
			...patch.payload
		}));
		const { error, status } = await client.rpc("apply_block_patches", { patches: payload });
		if (error) throwWithHttpStatus(error, status);
	}
};
var applyBlockDelete = async (id) => {
	const client = assertSupabase();
	console.debug("[powersync] DELETE", id);
	const { error, status } = await client.from("blocks").delete().eq("id", id);
	if (error) throwWithHttpStatus(error, status);
};
var applyBlockCreates = async (rows) => {
	if (rows.length === 0) return;
	const client = assertSupabase();
	for (const batch of chunk(orderedBlockUpserts(rows), MAX_BLOCKS_PER_SUPABASE_UPSERT)) {
		console.debug("[powersync] CREATE batch", batch.length);
		const { error, status } = await client.from("blocks").upsert(batch, {
			onConflict: "id",
			ignoreDuplicates: true
		});
		if (error) throwWithHttpStatus(error, status);
	}
};
var applyCompactedBlockOperations = async (_database, operations, sink = defaultBlockUploadSink) => {
	const creates = [];
	const patches = [];
	const deletes = [];
	for (const operation of operations) if (operation.kind === "create") creates.push(operation.payload);
	else if (operation.kind === "patch") patches.push({
		id: operation.id,
		payload: operation.payload
	});
	else deletes.push(operation.id);
	await sink.createRows(creates);
	if (patches.length > 0) await sink.applyPatches(patches);
	for (const id of deletes) await sink.deleteRow(id);
};
/** Production sink — Supabase under the hood. Tests pass a mock sink to
*  `applyCompactedBlockOperations` so they can assert which path each
*  operation took. */
var defaultBlockUploadSink = {
	createRows: applyBlockCreates,
	applyPatches: applyBlockPatchesRpc,
	deleteRow: applyBlockDelete
};
var collectUploadBatch = async (database) => {
	const transactions = [];
	const iterator = database.getCrudTransactions()[Symbol.asyncIterator]();
	let entryCount = 0;
	while (transactions.length < MAX_TRANSACTIONS_PER_UPLOAD_BATCH && (transactions.length === 0 || entryCount < MAX_CRUD_ENTRIES_PER_UPLOAD_BATCH)) {
		const next = await iterator.next();
		if (next.done || !next.value) break;
		transactions.push(next.value);
		entryCount += next.value.crud.length;
	}
	return transactions;
};
/** Records a permanently-rejected upload to the `ps_crud_rejected`
*  quarantine table so the bucket can keep draining. The row preserves
*  enough context (original ps_crud id, tx id, full envelope, error
*  code + message, wall-clock time) for a later UI surface or for
*  manual inspection via `kmagent sql`. */
var recordRejectionToTable = async (database, transaction, error) => {
	const errorCode = errorCodeOf(error);
	const errorMessage = errorMessageOf(error);
	const rejectedAt = Date.now();
	const txId = transaction.transactionId ?? transaction.crud[0]?.transactionId ?? 0;
	await database.writeTransaction(async (tx) => {
		await tx.execute(`DELETE FROM ps_crud_rejected WHERE tx_id = ?`, [txId]);
		for (const entry of transaction.crud) await tx.execute(`INSERT INTO ps_crud_rejected
           (original_id, tx_id, data, error_code, error_message, rejected_at)
         VALUES (?, ?, ?, ?, ?, ?)`, [
			entry.clientId,
			txId,
			JSON.stringify(crudEntryEnvelope(entry)),
			errorCode,
			errorMessage,
			rejectedAt
		]);
	});
};
var errorCodeOf = (error) => {
	if (typeof error === "object" && error !== null) {
		const candidate = error.code ?? error.status;
		if (typeof candidate === "string" || typeof candidate === "number") return String(candidate);
	}
	return null;
};
var errorMessageOf = (error) => {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	try {
		return JSON.stringify(error);
	} catch {
		return String(error);
	}
};
/** Reconstruct the JSON envelope that the upload-routing triggers wrote
*  into `ps_crud.data` (see clientSchema.ts). Keeping the same shape
*  here means a rejected row carries the exact wire payload, so the
*  rejection log reads symmetrically with the original queue. */
var crudEntryEnvelope = (entry) => {
	const opName = entry.op === UpdateType.PUT ? "PUT" : entry.op === UpdateType.PATCH ? "PATCH" : "DELETE";
	const data = entry.opData ?? {};
	return entry.op === UpdateType.DELETE ? {
		op: opName,
		type: entry.table,
		id: entry.id
	} : {
		op: opName,
		type: entry.table,
		id: entry.id,
		data
	};
};
var makeUploadDeps = (getWorkspaceMode, getCek) => ({
	applyOperations: applyCompactedBlockOperations,
	recordRejection: recordRejectionToTable,
	encryptOps: (ops) => encryptUploadOps(ops, getWorkspaceMode, getCek)
});
/** Records one more failed pass for an `ambiguous` tx and reports whether its
*  retry budget is now spent. A tx with no stable `transactionId` can't be
*  tracked across passes, so it's treated as already-exhausted (quarantine now)
*  rather than retried unbounded. */
var ambiguousBudgetExhausted = (attempts, transaction) => {
	const id = transaction.transactionId;
	if (id === void 0) return true;
	const next = (attempts.get(id) ?? 0) + 1;
	attempts.set(id, next);
	return next >= 5;
};
/** Clears a tx's ambiguous retry counter once it has drained (succeeded or been
*  quarantined), so the map stays bounded by the count of currently-stuck txs. */
var forgetAmbiguousAttempts = (attempts, transaction) => {
	if (transaction.transactionId !== void 0) attempts.delete(transaction.transactionId);
};
/** Optimistic-batch / pessimistic-per-tx upload orchestrator.
*
*  Happy path: one compacted batch → one applyOperations call → complete
*  the tail tx (which drains every preceding tx from ps_crud). Identical
*  perf to the original handler.
*
*  On batch failure: classify the error (see uploadErrorClassifier).
*    - transient (5xx / network / auth-token / rate-limit / unknown) →
*      re-throw so PowerSync retries the whole batch later.
*    - permanent (FK violation, RLS denial, malformed-request code, …) or
*      ambiguous (a suspected-permanent 4xx we can't confirm from a code) →
*      drop into the per-tx fallback.
*  The per-tx fallback applies each tx individually: complete() on success;
*  re-throw (retry) on a transient error; record to ps_crud_rejected +
*  complete() (quarantine) on a permanent error; and on an ambiguous error
*  retry it across AMBIGUOUS_RETRY_BUDGET upload passes, then quarantine. This
*  way one bad tx no longer jams the bucket — the rest of the queue drains and
*  the bad one lands in ps_crud_rejected for inspection.
*
*  Encrypt-on-upload (§9.2) is part of that isolation: a tx for an e2ee
*  workspace whose key is momentarily missing/unreadable makes `encryptOps`
*  throw. The BATCH encryption is guarded so that failure DOESN'T abort the
*  whole preflight — it falls through to the per-tx loop, which drains every
*  earlier (encryptable) tx and then stops at the un-encryptable one (its
*  per-tx `encryptOps` throws out of the loop). `complete()` is a checkpoint
*  that drains all PRECEDING txs, so we can't skip the bad tx and complete a
*  later one — instead PowerSync retries from it once the key is back. A
*  missing key is treated as transient (retry), never a rejection (which would
*  discard the edit). */
var uploadTransactionsWithFallback = async (database, transactions, deps, ambiguousAttempts = /* @__PURE__ */ new Map()) => {
	const encryptOps = deps.encryptOps ?? (async (ops) => ops);
	let batchOps = null;
	try {
		batchOps = await encryptOps(compactBlockCrudEntries(transactions.flatMap((t) => t.crud)));
	} catch (err) {
		console.warn("[powersync] batch encryption failed — isolating per tx", err);
	}
	if (batchOps) try {
		await deps.applyOperations(database, batchOps);
		await transactions[transactions.length - 1]?.complete();
		for (const transaction of transactions) forgetAmbiguousAttempts(ambiguousAttempts, transaction);
		return;
	} catch (err) {
		if (classifyUploadError(err) === "transient") {
			console.error("[powersync] upload failed (transient, will retry)", err);
			throw err;
		}
		console.warn(`[powersync] batch upload failed — isolating ${transactions.length} tx(s)`, err);
	}
	for (const transaction of transactions) {
		const txOps = await encryptOps(compactBlockCrudEntries(transaction.crud));
		try {
			await deps.applyOperations(database, txOps);
			await transaction.complete();
			forgetAmbiguousAttempts(ambiguousAttempts, transaction);
		} catch (err) {
			const classification = classifyUploadError(err);
			if (classification === "transient") {
				console.error("[powersync] per-tx upload failed (transient, will retry)", err);
				throw err;
			}
			if (classification === "ambiguous" && !ambiguousBudgetExhausted(ambiguousAttempts, transaction)) {
				console.warn(`[powersync] tx ${transaction.transactionId} ambiguous upload error — retrying`, err);
				throw err;
			}
			console.warn(`[powersync] tx ${transaction.transactionId} rejected — quarantining`, err);
			await deps.recordRejection(database, transaction, err);
			await transaction.complete();
			forgetAmbiguousAttempts(ambiguousAttempts, transaction);
		}
	}
};
var runUploadLoop = async (database, deps, ambiguousAttempts) => {
	while (true) {
		const transactions = await collectUploadBatch(database);
		if (transactions.length === 0) return;
		await uploadTransactionsWithFallback(database, transactions, deps, ambiguousAttempts);
	}
};
var fetchCredentials = async () => {
	const client = assertSupabase();
	let session = readPersistedSession();
	try {
		const { data, error } = await client.auth.getSession();
		if (error) throw error;
		if (data.session) session = data.session;
	} catch (error) {
		if (!session) {
			console.debug("[powersync] fetchCredentials: no session available (offline?)", error);
			return null;
		}
	}
	if (!session?.access_token || !powerSyncUrl) return null;
	return {
		endpoint: powerSyncUrl,
		token: session.access_token,
		expiresAt: session.expires_at ? /* @__PURE__ */ new Date(session.expires_at * 1e3) : void 0
	};
};
var createPowerSyncConnector = (options = {}) => {
	const deps = makeUploadDeps(options.getWorkspaceMode ?? defaultGetWorkspaceMode, options.getCek ?? defaultUploadGetCek);
	const ambiguousAttempts = /* @__PURE__ */ new Map();
	return {
		fetchCredentials,
		uploadData: (database) => runUploadLoop(database, deps, ambiguousAttempts)
	};
};
//#endregion
export { createPowerSyncConnector, hasRemoteSyncConfig };

//# sourceMappingURL=powersync.js.map