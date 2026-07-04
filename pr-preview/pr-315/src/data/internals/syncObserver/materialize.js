import { BLOCK_STORAGE_COLUMNS, parseBlockRow } from "../../blockSchema.js";
import { decideStagingRow } from "./reconcile.js";
import { decodeFromWire } from "../../../sync/transform.js";
//#region src/data/internals/syncObserver/materialize.ts
/**
* Layout B observer — materialization core (design doc §9.2).
*
* Turns `blocks_synced` staging rows into the app-visible plaintext `blocks`
* table. This is the data-movement heart of the observer, kept separate from
* the change-subscription wiring (which decides *when* to run it) and the
* invalidation relocation (which decides *who to notify* afterwards) so it can
* be exhaustively tested against a real DB.
*
* For each staging row it answers, via the pure {@link decideStagingRow}:
*
*   - apply (decrypt)  — e2ee workspace with the WK loaded: run the content
*     columns through {@link decodeFromWire}, write plaintext to `blocks`.
*   - apply (copy)     — plaintext workspace: write the row through unchanged.
*   - defer            — not materializable yet (locked/key-required e2ee, or
*     encryption-uncertain): leave it in staging for a later drain.
*   - skip-stale       — materializable, but a newer/pending local edit must
*     not be clobbered; let the upload echo reconcile.
*
* And for ids that left the synced set (`removed`) it hard-deletes the local
* `blocks` row (membership revoke / workspace delete / true stream-exit).
*
* EVERY write here leaves `tx_context.source` NULL — identical to how
* PowerSync's own CRUD-apply path writes the tables it manages. The
* upload-routing triggers gate on `source IS NOT NULL`, so they skip these
* writes (no echo-upload loop), while the ungated derived-index triggers
* (aliases / types / FTS) still fire and keep those indexes current.
*/
var COLUMN_NAMES = BLOCK_STORAGE_COLUMNS.map((column) => column.name);
var PLACEHOLDERS = COLUMN_NAMES.map(() => "?").join(", ");
var UPDATE_ASSIGNMENTS = COLUMN_NAMES.filter((name) => name !== "id").map((name) => `${name} = excluded.${name}`).join(", ");
var UPSERT_BLOCK_SQL = `
  INSERT INTO blocks (${COLUMN_NAMES.join(", ")})
  VALUES (${PLACEHOLDERS})
  ON CONFLICT(id) DO UPDATE SET ${UPDATE_ASSIGNMENTS}
`;
var DELETE_BLOCK_SQL = "DELETE FROM blocks WHERE id = ?";
var PENDING_UPLOAD_IDS_SQL = `
  SELECT DISTINCT json_extract(data, '$.id') AS id FROM ps_crud
   WHERE json_extract(data, '$.type') = 'blocks'
`;
var blockRowParams = (row) => COLUMN_NAMES.map((name) => row[name]);
var buildInClause = (count) => Array.from({ length: count }, () => "?").join(", ");
var STAGING_READ_CHUNK = 500;
/** Read staging rows for `ids` in bounded chunks so the IN-clause never exceeds
*  SQLite's bound-parameter limit. Missing ids (already removed) are simply
*  absent from the result. */
var readStagingRows = async (db, ids, chunkSize) => {
	const out = [];
	for (let i = 0; i < ids.length; i += chunkSize) {
		const chunk = ids.slice(i, i + chunkSize);
		const rows = await db.getAll(`SELECT ${COLUMN_NAMES.join(", ")} FROM blocks_synced
        WHERE id IN (${buildInClause(chunk.length)})`, chunk);
		out.push(...rows);
	}
	return out;
};
/** Local gate inputs for the `ids` the app already has a `blocks` row for,
*  keyed by id. Chunked so the IN-clause never exceeds SQLite's bound-parameter
*  limit. Absent ids = no local row. This is the Phase-1 slim read (id +
*  updated_at) — Phase 2 re-derives the same field from the full before-rows
*  it already loads. */
var readLocalGateRows = async (db, ids, chunkSize) => {
	const out = /* @__PURE__ */ new Map();
	for (let i = 0; i < ids.length; i += chunkSize) {
		const chunk = ids.slice(i, i + chunkSize);
		const rows = await db.getAll(`SELECT id, updated_at FROM blocks WHERE id IN (${buildInClause(chunk.length)})`, chunk);
		for (const row of rows) out.set(row.id, { updatedAt: row.updated_at });
	}
	return out;
};
/** Full pre-write `blocks` rows for `ids`, keyed by id — serves both the LWW
*  gate's local stamp and the invalidation `before` snapshot (parent-edge /
*  plugin channels need the prior parent_id, content, properties, etc.).
*  Chunked like the staging read. */
var readBlocksByIds = async (db, ids, chunkSize) => {
	const out = /* @__PURE__ */ new Map();
	for (let i = 0; i < ids.length; i += chunkSize) {
		const chunk = ids.slice(i, i + chunkSize);
		const rows = await db.getAll(`SELECT ${COLUMN_NAMES.join(", ")} FROM blocks WHERE id IN (${buildInClause(chunk.length)})`, chunk);
		for (const row of rows) out.set(row.id, row);
	}
	return out;
};
/** Block ids with an unsent local edit queued for upload (a single read of the
*  whole upload queue, not a per-row probe). */
var readPendingUploadIds = async (db) => {
	const rows = await db.getAll(PENDING_UPLOAD_IDS_SQL);
	return new Set(rows.map((row) => row.id));
};
/** Subset of `ids` that still have a row in the `blocks_synced` staging table.
*  Chunked like the other id-keyed reads. */
var readExistingStagingIds = async (db, ids, chunkSize) => {
	const out = /* @__PURE__ */ new Set();
	for (let i = 0; i < ids.length; i += chunkSize) {
		const chunk = ids.slice(i, i + chunkSize);
		const rows = await db.getAll(`SELECT id FROM blocks_synced WHERE id IN (${buildInClause(chunk.length)})`, chunk);
		for (const row of rows) out.add(row.id);
	}
	return out;
};
/**
* Process one staging-table delta: decrypt/copy materializable rows into
* `blocks`, leave non-materializable rows staged, skip rows a local edit
* should win, and hard-delete rows that left the synced set.
*
* Two phases. Phase 1 (outside the write tx) resolves materializability, runs
* the staleness gate, and decrypts ONLY the rows that pass it — so a stale
* (and possibly undecryptable: tampered, opened with the wrong key) ciphertext
* we're going to skip anyway never reaches `decodeFromWire` and can't abort
* the batch. Phase 2 (inside the write tx) re-runs the gate authoritatively
* before writing: the two write transactions are serialized, but the Phase-1
* reads are not in the lock, so a local edit can land in between and must
* still win. Keeping decrypt out of the lock also keeps the write window
* short.
*/
var materializeStagingRows = async (db, change, deps, options = {}) => {
	const { getMaterializability, getCek } = deps;
	const readChunkSize = options.readChunkSize ?? STAGING_READ_CHUNK;
	const deferred = [];
	const skippedStale = [];
	const quarantined = [];
	const stagingRows = await readStagingRows(db, change.upserted, readChunkSize);
	const localGateRowById = await readLocalGateRows(db, stagingRows.map((row) => row.id), readChunkSize);
	const pendingUploadIds = await readPendingUploadIds(db);
	const materializabilityByWs = /* @__PURE__ */ new Map();
	const resolveMaterializability = async (workspaceId) => {
		const cached = materializabilityByWs.get(workspaceId);
		if (cached !== void 0) return cached;
		const resolved = await getMaterializability(workspaceId);
		materializabilityByWs.set(workspaceId, resolved);
		return resolved;
	};
	const candidates = [];
	for (const row of stagingRows) {
		const materializability = await resolveMaterializability(row.workspace_id);
		if (materializability === "defer") {
			deferred.push(row.id);
			continue;
		}
		const localRow = localGateRowById.get(row.id);
		if (decideStagingRow(materializability, row.updated_at, {
			localUpdatedAt: localRow?.updatedAt ?? null,
			hasPendingUpload: pendingUploadIds.has(row.id)
		}).kind !== "apply") {
			skippedStale.push(row.id);
			continue;
		}
		const mode = materializability === "decrypt" ? "e2ee" : "none";
		let plaintext;
		try {
			plaintext = await decodeFromWire(row, mode, getCek);
		} catch (err) {
			console.warn(`[materializeStagingRows] quarantined undecryptable block ${row.id}:`, err);
			quarantined.push(row.id);
			continue;
		}
		candidates.push({
			plaintext,
			stagingUpdatedAt: row.updated_at,
			materializability
		});
	}
	const snapshots = /* @__PURE__ */ new Map();
	const applied = [];
	const deleted = [];
	if (candidates.length === 0 && change.removed.length === 0) return {
		snapshots,
		applied,
		deferred,
		skippedStale,
		quarantined,
		deleted
	};
	await db.writeTransaction(async (tx) => {
		await tx.execute("UPDATE tx_context SET source = NULL WHERE id = 1");
		const beforeRowById = await readBlocksByIds(tx, candidates.map((candidate) => candidate.plaintext.id), readChunkSize);
		const pendingNow = await readPendingUploadIds(tx);
		for (const candidate of candidates) {
			const { plaintext, stagingUpdatedAt, materializability } = candidate;
			const beforeRow = beforeRowById.get(plaintext.id) ?? null;
			if (decideStagingRow(materializability, stagingUpdatedAt, {
				localUpdatedAt: beforeRow?.updated_at ?? null,
				hasPendingUpload: pendingNow.has(plaintext.id)
			}).kind === "apply") {
				await tx.execute(UPSERT_BLOCK_SQL, blockRowParams(plaintext));
				applied.push(plaintext.id);
				snapshots.set(plaintext.id, {
					before: beforeRow ? parseBlockRow(beforeRow) : null,
					after: parseBlockRow(plaintext)
				});
			} else skippedStale.push(plaintext.id);
		}
		const removedBeforeById = await readBlocksByIds(tx, change.removed, readChunkSize);
		const removedStillStaged = await readExistingStagingIds(tx, change.removed, readChunkSize);
		for (const id of change.removed) {
			if (removedStillStaged.has(id)) continue;
			await tx.execute(DELETE_BLOCK_SQL, [id]);
			deleted.push(id);
			const beforeRow = removedBeforeById.get(id);
			if (beforeRow) snapshots.set(id, {
				before: parseBlockRow(beforeRow),
				after: null
			});
		}
	});
	return {
		snapshots,
		applied,
		deferred,
		skippedStale,
		quarantined,
		deleted
	};
};
//#endregion
export { materializeStagingRows };

//# sourceMappingURL=materialize.js.map