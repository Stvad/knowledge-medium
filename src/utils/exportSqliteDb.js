import v4 from "../../node_modules/uuid/dist/v4.js";
import { dbFilenameForUser } from "../data/repoProvider.js";
import { Zip, ZipPassThrough } from "../../node_modules/fflate/esm/browser.js";
//#region src/utils/exportSqliteDb.ts
/**
* Download / replace a raw `.db` image for the current user's
* PowerSync SQLite database.
*
* With OPFSCoopSyncVFS the database is a real file at OPFS root. Export
* must not hand that live file directly to the browser download stack:
* on large databases the app/sync writer can change the file while
* Chrome is still reading it. The reliable path is to hold PowerSync's
* adapter lock while streaming the current .db image to either a user
* chosen file (Chrome File System Access API) or an OPFS temp snapshot.
*
* Import validates a tiny header first, streams the selected file into
* OPFS staging while the live DB is still intact, then closes PowerSync
* and replaces the current user's .db from that staging file.
*/
function rawSqliteDbExportFilenameForUser(userId, now = Date.now()) {
	return `${dbFilenameForUser(userId).replace(/\.db$/, "")}-export-${now}.db`;
}
function rawSqliteDbRecoveryZipFilenameForUser(userId, now = Date.now()) {
	return `${dbFilenameForUser(userId).replace(/\.db$/, "")}-recovery-${now}.zip`;
}
function rawSqliteDbExportFilename(repo, now = Date.now()) {
	return rawSqliteDbExportFilenameForUser(repo.user.id, now);
}
async function chooseRawSqliteExportFile(filename) {
	const picker = globalThis.showSaveFilePicker;
	if (!picker) return void 0;
	return picker({
		suggestedName: filename,
		types: [{
			description: "SQLite database",
			accept: {
				"application/vnd.sqlite3": [
					".db",
					".sqlite",
					".sqlite3"
				],
				"application/octet-stream": [".db"]
			}
		}]
	});
}
async function exportRawSqliteDbToFile(repo, destinationHandle) {
	const userId = repo.user.id;
	const dbFilename = dbFilenameForUser(userId);
	const filename = destinationHandle.name || rawSqliteDbExportFilename(repo);
	const fileHandle = await (await navigator.storage.getDirectory()).getFileHandle(dbFilename);
	return {
		filename,
		size: await withPowerSyncReadLock(repo, async () => {
			const sourceFile = await fileHandle.getFile();
			await pipeBlobToFileHandle(sourceFile, destinationHandle);
			return sourceFile.size;
		})
	};
}
async function exportRawSqliteDb(repo) {
	const userId = repo.user.id;
	const dbFilename = dbFilenameForUser(userId);
	const filename = rawSqliteDbExportFilename(repo);
	const snapshotName = tempOpfsFilename(dbFilename, "export-snapshot");
	const root = await navigator.storage.getDirectory();
	const sourceFile = await (await root.getFileHandle(dbFilename)).getFile();
	const freeBytes = await estimateFreeOpfsBytes();
	if (freeBytes !== void 0 && freeBytes < sourceFile.size) throw new Error(insufficientOpfsSpaceMessage(sourceFile.size, freeBytes));
	const snapshotHandle = await root.getFileHandle(snapshotName, { create: true });
	try {
		await withPowerSyncReadLock(repo, async () => {
			await pipeBlobToFileHandle(sourceFile, snapshotHandle);
		});
	} catch (err) {
		await removeEntryIfExists(root, snapshotName);
		if (err instanceof DOMException && err.name === "QuotaExceededError") throw new Error(insufficientOpfsSpaceMessage(sourceFile.size, await estimateFreeOpfsBytes()), { cause: err });
		throw err;
	}
	return {
		blob: await snapshotHandle.getFile(),
		filename,
		cleanup: () => removeEntryIfExists(root, snapshotName)
	};
}
/**
* Build the recovery backup (the corrupt bytes included), WITHOUT a PowerSync
* read lock — use only on the corruption path, where the caller already released
* the connection (`closePowerSyncDbIfOpen`) so nothing holds the OPFS handle. For
* a live DB use `exportRawSqliteDb`, which snapshots under the adapter lock.
*
* Includes the raw `.db` PLUS any crash-recovery siblings that have bytes
* (`-journal` hot rollback journal / `-wal` / `-shm`). The reset path deletes
* those siblings, and a hot journal can be exactly what SQLite needs to roll a
* corrupt DB back to a recoverable state — so dropping them from the backup
* would leave the user's retained copy unrecoverable in that case. We weigh the
* `.db` and the siblings TOGETHER: a 0-byte `.db` next to a non-empty journal
* must still back up the journal, not reject as "nothing to back up".
*
* Single non-empty file (`.db` alone — incl. the original iPad incident) → a
* plain `.db` the user can hand straight to `sqlite3 .recover`, no unzip step.
* More than one → bundle the fileset into one `.zip` (a single download is the
* only reliable way to deliver multiple files on iOS), keeping the original OPFS
* names so SQLite re-pairs the journal on extract. Rejects only when there is
* genuinely nothing with bytes anywhere.
*/
async function getRawSqliteDbBackup(userId) {
	const dbFilename = dbFilenameForUser(userId);
	const root = await navigator.storage.getDirectory();
	const dbFile = await readOpfsFileIfExists(root, dbFilename);
	const dbEntry = dbFile && dbFile.size > 0 ? {
		name: dbFilename,
		file: dbFile
	} : null;
	const siblings = [];
	for (const suffix of DB_FILE_SIBLING_SUFFIXES) {
		const name = dbFilename + suffix;
		const file = await readOpfsFileIfExists(root, name);
		if (file && file.size > 0) siblings.push({
			name,
			file
		});
	}
	if (!dbEntry && siblings.length === 0) throw new Error("The local database files are empty — there is nothing to back up.");
	if (dbEntry && siblings.length === 0) return {
		blob: dbEntry.file,
		filename: rawSqliteDbExportFilenameForUser(userId),
		contents: [dbEntry.name]
	};
	const entries = [...dbEntry ? [dbEntry] : [], ...siblings];
	const totalBytes = entries.reduce((sum, e) => sum + e.file.size, 0);
	const freeBytes = await estimateFreeOpfsBytes();
	if (freeBytes !== void 0 && freeBytes < totalBytes) throw new Error(insufficientOpfsSpaceMessage(totalBytes, freeBytes));
	const tempName = tempOpfsFilename(dbFilename, "recovery-zip");
	return {
		blob: await (await streamStoredZipToOpfs(root, entries, tempName)).getFile(),
		filename: rawSqliteDbRecoveryZipFilenameForUser(userId),
		cleanup: () => removeEntryIfExists(root, tempName),
		contents: entries.map((e) => e.name)
	};
}
/**
* Delete the user's local SQLite files from OPFS — the `.db` plus its
* `-journal` / `-wal` / `-shm` siblings. Leaves everything else intact:
* IndexedDB (e2ee workspace keys), the auth session, and the OPFS `assets/`
* media tree. The OPFSCoopSyncVFS `.ahp-*` access-handle pools are left for the
* next VFS init to reclaim (its initialize step drops stale pools whose lock is
* free), so a fresh PowerSync init re-creates an empty DB and re-syncs.
*
* The caller MUST close the PowerSync connection first (release the OPFS sync
* access handle) — otherwise `removeEntry` can throw on the locked `.db`.
*
* Deletes the journal/WAL siblings BEFORE the main `.db`, and if any sibling
* can't be removed it throws WITHOUT touching the `.db`. Rationale: a fresh
* empty `.db` recreated on the next boot next to a leftover `-wal`/`-journal`
* would replay the stale journal and silently re-corrupt (see
* `importRawSqliteDb`). A surviving corrupt `.db` is recoverable (retry); a
* journal replay onto a fresh DB is not.
*/
async function deleteLocalSqliteDb(userId) {
	const dbFilename = dbFilenameForUser(userId);
	const root = await navigator.storage.getDirectory();
	const siblingFailure = (await Promise.allSettled(DB_FILE_SIBLING_SUFFIXES.map((suffix) => removeEntryIfExists(root, dbFilename + suffix)))).find((r) => r.status === "rejected");
	if (siblingFailure) throw new Error("Could not delete all local database files — a journal file may be locked by another open tab of this app. The main database was left in place to avoid re-corruption; close other tabs and try again.", { cause: siblingFailure.reason });
	await removeEntryIfExists(root, dbFilename);
}
/**
* Remove any leftover recovery-backup `.zip` temp files for this user. The
* recovery backup streams a full-size zip into an OPFS temp and relies on
* `downloadBlob`'s delayed cleanup timer — but the reset path reloads the page,
* which cancels that timer and would otherwise leak gigabytes of OPFS quota. The
* reset calls this before reloading; it's safe to drop the temp because the
* recovery UI only unlocks reset after the user confirmed the download saved.
* Best-effort and idempotent.
*/
async function removeRecoveryBackupTemps(userId) {
	const prefix = `.${dbFilenameForUser(userId)}.recovery-zip-`;
	const root = await navigator.storage.getDirectory();
	const stale = [];
	for await (const name of root.keys()) if (name.startsWith(prefix) && name.endsWith(".tmp")) stale.push(name);
	await Promise.all(stale.map((name) => removeEntryIfExists(root, name)));
}
var BYTES_PER_MIB = 1024 * 1024;
var estimateFreeOpfsBytes = async () => {
	if (typeof navigator.storage?.estimate !== "function") return void 0;
	const { quota, usage } = await navigator.storage.estimate();
	if (typeof quota !== "number" || typeof usage !== "number") return void 0;
	return Math.max(0, quota - usage);
};
var insufficientOpfsSpaceMessage = (requiredBytes, freeBytes) => {
	const toMiB = (bytes) => (bytes / BYTES_PER_MIB).toFixed(1);
	const haveClause = freeBytes !== void 0 && freeBytes < requiredBytes ? ` but only ${toMiB(freeBytes)} MiB is available` : "";
	const pickerHint = typeof globalThis.showSaveFilePicker === "function" ? "" : " (A Chromium-based browser can export without this temporary copy, but it keeps its own separate local database and would not include anything that exists only in this browser, such as unsynced changes or local history.)";
	return `Not enough browser storage to export the SQLite database: the export first copies it into browser storage (OPFS), which needs ${toMiB(requiredBytes)} MiB of free space${haveClause}. Free up storage for this site and try again.${pickerHint}`;
};
function downloadBlob(blob, filename, cleanup) {
	const url = URL.createObjectURL(blob);
	try {
		const a = document.createElement("a");
		a.href = url;
		a.download = filename;
		document.body.appendChild(a);
		a.click();
		a.remove();
	} finally {
		setTimeout(() => URL.revokeObjectURL(url), 0);
		if (cleanup) setTimeout(() => {
			Promise.resolve(cleanup()).catch((error) => {
				console.warn("[export-db] failed to clean export snapshot:", error);
			});
		}, 3600 * 1e3);
	}
}
var SQLITE_MAGIC = new Uint8Array([
	83,
	81,
	76,
	105,
	116,
	101,
	32,
	102,
	111,
	114,
	109,
	97,
	116,
	32,
	51,
	0
]);
/**
* Replace the current user's OPFS .db file with the supplied bytes.
* After this resolves the live `repo` is dead (its DB connection has
* been closed); the caller must reload the page so a fresh PowerSync
* init opens the new file.
*/
async function importRawSqliteDb(repo, file) {
	if (file.size < SQLITE_MAGIC.length) throw new Error("Selected file is too small to be a SQLite database.");
	const headerBuffer = await file.slice(0, SQLITE_MAGIC.length).arrayBuffer();
	const head = new Uint8Array(headerBuffer);
	for (let i = 0; i < SQLITE_MAGIC.length; i++) if (head[i] !== SQLITE_MAGIC[i]) throw new Error("Selected file is not a SQLite database (missing magic header).");
	const userId = repo.user.id;
	const dbFilename = dbFilenameForUser(userId);
	const stagingName = tempOpfsFilename(dbFilename, "import-staging");
	const root = await navigator.storage.getDirectory();
	const stagingHandle = await root.getFileHandle(stagingName, { create: true });
	try {
		await pipeBlobToFileHandle(file, stagingHandle);
		await repo.db.close();
		for (const suffix of DB_FILE_SIBLING_SUFFIXES) await removeEntryIfExists(root, dbFilename + suffix);
		await pipeBlobToFileHandle(await stagingHandle.getFile(), await root.getFileHandle(dbFilename, { create: true }));
	} finally {
		await removeEntryIfExists(root, stagingName);
	}
}
var withPowerSyncReadLock = async (repo, callback) => {
	const db = repo.db;
	if (typeof db.readLock !== "function") throw new Error("PowerSync database does not expose readLock; cannot safely snapshot live SQLite DB.");
	return db.readLock(async () => callback());
};
var pipeBlobToFileHandle = async (blob, fileHandle) => {
	const writable = await fileHandle.createWritable({ keepExistingData: false });
	await blob.stream().pipeTo(writable);
};
var DB_FILE_SIBLING_SUFFIXES = [
	"-journal",
	"-wal",
	"-shm"
];
var removeEntryIfExists = async (root, name) => {
	try {
		await root.removeEntry(name);
	} catch (err) {
		if (!(err instanceof DOMException && err.name === "NotFoundError")) throw err;
	}
};
var readOpfsFileIfExists = async (root, name) => {
	try {
		return await (await root.getFileHandle(name)).getFile();
	} catch (err) {
		if (err instanceof DOMException && err.name === "NotFoundError") return null;
		throw err;
	}
};
/**
* Stream a STORED (uncompressed) zip of the given OPFS files into a new OPFS
* temp file, returning its handle. Streamed (not `zipSync`) because the `.db`
* can be gigabytes: each file is piped disk → zip → disk with backpressure, so
* we never hold the whole archive in memory. Store mode keeps it CPU-light —
* compressing an already-dense SQLite file buys almost nothing. On any failure
* the partial temp file is removed before the error propagates.
*/
var streamStoredZipToOpfs = async (root, entries, tempName) => {
	const tempHandle = await root.getFileHandle(tempName, { create: true });
	const writable = await tempHandle.createWritable({ keepExistingData: false });
	let writeChain = Promise.resolve();
	let zipError = null;
	const zip = new Zip((err, chunk) => {
		if (err) {
			zipError = err;
			return;
		}
		writeChain = writeChain.then(() => writable.write(chunk));
	});
	try {
		for (const { name, file } of entries) {
			const passthrough = new ZipPassThrough(name);
			zip.add(passthrough);
			const reader = file.stream().getReader();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				passthrough.push(value, false);
				await writeChain;
				if (zipError) throw zipError;
			}
			passthrough.push(new Uint8Array(0), true);
		}
		zip.end();
		await writeChain;
		if (zipError) throw zipError;
		await writable.close();
	} catch (err) {
		await writable.abort?.().catch(() => {});
		await removeEntryIfExists(root, tempName);
		throw err;
	}
	return tempHandle;
};
var tempOpfsFilename = (dbFilename, purpose) => `.${dbFilename}.${purpose}-${Date.now()}-${v4()}.tmp`;
//#endregion
export { chooseRawSqliteExportFile, deleteLocalSqliteDb, downloadBlob, exportRawSqliteDb, exportRawSqliteDbToFile, getRawSqliteDbBackup, importRawSqliteDb, rawSqliteDbExportFilename, rawSqliteDbExportFilenameForUser, rawSqliteDbRecoveryZipFilenameForUser, removeRecoveryBackupTemps };

//# sourceMappingURL=exportSqliteDb.js.map