import { Schema } from "../../node_modules/@powersync/common/dist/bundle.js";
import { BLOCKS_SYNCED_RAW_TABLE, CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL, CREATE_BLOCKS_SYNCED_TABLE_SQL, CREATE_BLOCKS_TABLE_SQL, CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL } from "./blockSchema.js";
import { CLIENT_SCHEMA_STATEMENTS, backfillBlockAliasesIfEmpty, backfillBlockTypesIfEmpty, backfillBlocksFtsIfEmpty, ensureBlockUserUpdatedAtColumn, ensureUndoGroupIdColumns, runAnalyzeIfStale } from "./internals/clientSchema.js";
import { scheduleIdle } from "../utils/scheduleIdle.js";
import { createPowerSyncConnector, hasRemoteSyncConfig } from "../services/powersync.js";
import { WASQLiteVFS } from "../../node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/vfs.js";
import { WASQLiteOpenFactory } from "../../node_modules/@powersync/web/lib/src/db/adapters/wa-sqlite/WASQLiteOpenFactory.js";
import { PowerSyncDatabase } from "../../node_modules/@powersync/web/lib/src/db/PowerSyncDatabase.js";
import "../../node_modules/@powersync/web/lib/src/index.js";
import { createSyncResolver } from "../sync/keys/resolver.js";
import { getWorkspaceKeyStore } from "../sync/keys/keyStore.js";
import { CREATE_WORKSPACES_TABLE_SQL, CREATE_WORKSPACE_MEMBERS_INDEX_SQL, CREATE_WORKSPACE_MEMBERS_TABLE_SQL, WORKSPACES_RAW_TABLE, WORKSPACE_MEMBERS_RAW_TABLE, ensureWorkspaceE2eeColumns } from "./workspaceSchema.js";
import "./maintenance.js";
import { onFirstSync } from "./internals/firstSync.js";
import { toLocalDbOpenError } from "../utils/localDbCorruption.js";
import { captureDbOpenCorruption, recordForensicSessionStart, watchForRuntimeCorruption } from "../utils/dbForensicsHooks.js";
import { releasePowerSyncConnection } from "./releasePowerSyncConnection.js";
import { applyLocalSchemaContributions, resolveLocalSchemaContributions } from "./localSchema.js";
import { guardSyncedTableWrites } from "./syncedTableWriteGuard.js";
import { staticDataExtensions } from "../extensions/staticDataExtensions.js";
//#region src/data/repoProvider.ts
/**
* Production bootstrap for the new data layer (replaces
* `src/data/repoInstance.ts`).
*
* Per-user PowerSync database — the database itself is the user
* isolation boundary (no shared CRUD queue, no shared cache, no risk
* of one session's pending uploads being retried under another user's
* JWT). Sign-out clears the Supabase session but leaves the local DB
* intact; sign-in as the same user reopens the same DB and unsynced
* edits resume uploading. Sign-in as a different user opens a fresh
* DB.
*
* What this DOES:
*   - Open a `PowerSyncDatabase` keyed by user id
*   - Run PowerSync's `init()` (sets up powersync_crud + ps_oplog)
*   - Run the new client-side DDL: `blocks` + core indexes,
*     workspaces + workspace_members tables/indexes,
*     `CLIENT_SCHEMA_STATEMENTS` (tx_context, row_events,
*     command_events, core side indexes, and triggers), then static
*     data-plugin local schema contributions
*   - Connect to the PowerSync server when `hasRemoteSyncConfig`
*
* What this does NOT do (vs. legacy):
*   - No `block_event_context` / `block_events` tables (replaced by
*     `tx_context` + `row_events` from clientSchema.ts)
*   - No legacy CRUD-routing triggers (replaced by the 5 audit/upload
*     triggers in clientSchema.ts that key on `tx_context.source`)
*   - No `UndoRedoManager` (undo lands in a future stage; engine
*     doesn't depend on it)
*/
var appSchema = new Schema({});
appSchema.withRawTables({
	blocks_synced: BLOCKS_SYNCED_RAW_TABLE,
	workspaces: WORKSPACES_RAW_TABLE,
	workspace_members: WORKSPACE_MEMBERS_RAW_TABLE
});
var MAX_USER_SEGMENT = 40;
var previewDbSuffix = (base) => {
	const match = base.match(/\/pr-preview\/(pr-[^/]+)\//);
	return match ? `-${match[1]}` : "";
};
var dbFilenameForUser = (userId, base = "/knowledge-medium/pr-preview/pr-312/") => {
	const suffix = previewDbSuffix(base);
	return `kmp-v6-${userId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, Math.max(0, MAX_USER_SEGMENT - suffix.length))}${suffix}.db`;
};
var dbsByUser = /* @__PURE__ */ new Map();
var initPromises = /* @__PURE__ */ new Map();
var activeUserId = null;
var activeRemoteSync = false;
var connectChain = Promise.resolve();
var syncResolversByUser = /* @__PURE__ */ new Map();
var resolverForUser = (userId) => {
	let resolver = syncResolversByUser.get(userId);
	if (!resolver) {
		resolver = createSyncResolver(() => userId, getWorkspaceKeyStore());
		syncResolversByUser.set(userId, resolver);
	}
	return resolver;
};
/** The active user id (whose per-user PowerSync DB is mounted), or null when
*  signed out. The asset byte path (§7.3) scopes its OPFS store + resolver to
*  this — re-read at call time so an account switch is reflected. */
var getActiveUserId = () => activeUserId;
/** Whether the active session has remote sync ENABLED (vs local-only). The attachment
*  up-lane + resolver gate on this so a local-only session uploads/fetches NOTHING
*  to/from Supabase Storage — `supabase` being non-null only means auth is CONFIGURED,
*  not that this session opted into remote. */
var isRemoteSyncActive = () => activeRemoteSync;
/** The active user's §6 sync resolver (materializability / WK / K_id), or null
*  when signed out. The in-thread asset resolver delegates its decode + content-
*  key decisions to it, so they share the one §6 policy source. */
var getActiveSyncResolver = () => activeUserId ? resolverForUser(activeUserId) : null;
/** The §6 sync resolver for a SPECIFIC user (materializability / WK / K_id),
*  regardless of who is active. The byte up-lane binds this at its entry boundary
*  (capture / drain) so an operation initiated for one user can't read another
*  user's keys if the active account switches mid-flight. (The read-path asset
*  resolver legitimately follows the ACTIVE user instead — see assetResolver.ts.) */
var syncResolverForUser = (userId) => resolverForUser(userId);
/** Observer deps for the Repo's `syncObserverDeps` parameter, drawn from
*  the same per-user resolver the upload connector uses — so download
*  (decrypt/copy/defer) and upload (encrypt) share one §6 policy source. */
var syncObserverDepsFor = (userId) => {
	const resolver = resolverForUser(userId);
	return {
		getMaterializability: resolver.getMaterializability,
		getCek: resolver.getCek
	};
};
var opfsProbe = null;
var assertOpfsAvailable = () => {
	if (!opfsProbe) opfsProbe = (async () => {
		try {
			await navigator.storage.getDirectory();
		} catch (err) {
			if (err instanceof DOMException && err.name === "SecurityError") throw new Error("This browser is blocking local storage access (OPFS), which Knowledge Medium needs to keep your data on this device. This usually means you're in private/incognito browsing on Firefox or Safari, where OPFS is disabled. Try a regular (non-private) window, or use Chrome — Chrome incognito allows OPFS.", { cause: err });
			throw err;
		}
	})();
	return opfsProbe;
};
var buildPowerSyncDb = (userId) => new PowerSyncDatabase({
	schema: appSchema,
	database: new WASQLiteOpenFactory({
		dbFilename: dbFilenameForUser(userId),
		vfs: WASQLiteVFS.OPFSCoopSyncVFS
	}),
	flags: { enableMultiTabs: true }
});
var getPowerSyncDb = (userId) => {
	const existing = dbsByUser.get(userId);
	if (existing) return existing;
	const db = buildPowerSyncDb(userId);
	dbsByUser.set(userId, db);
	return db;
};
/**
* Close the user's PowerSync connection IF one was already constructed (release
* the OPFS sync access handle) and forget it. Unlike `getPowerSyncDb`, this NEVER
* constructs a connection — the recovery path is about to delete the `.db`, and
* opening a fresh connection to it would re-acquire the very handle we need
* released (and re-fail on the corrupt file). No-op when nothing is open.
*
* A failed-init connection (corrupt DB) needs the adapter released directly —
* its high-level close() re-throws the rejected init before freeing the OPFS
* handle — so we go through `releasePowerSyncConnection`. We still drop it from
* the maps so a later reload re-inits cleanly.
*/
var closePowerSyncDbIfOpen = async (userId) => {
	const existing = dbsByUser.get(userId);
	dbsByUser.delete(userId);
	initPromises.delete(userId);
	if (!existing) return;
	await releasePowerSyncConnection(existing);
};
var ensurePowerSyncReady = async (userId, useRemoteSync = hasRemoteSyncConfig) => {
	await assertOpfsAvailable();
	const db = getPowerSyncDb(userId);
	const dbFilename = dbFilenameForUser(userId);
	let initPromise = initPromises.get(userId);
	if (!initPromise) {
		initPromise = initializePowerSyncDb(db);
		initPromises.set(userId, initPromise);
	}
	try {
		await initPromise;
	} catch (error) {
		captureDbOpenCorruption(userId, dbFilename, error);
		throw toLocalDbOpenError(error, userId);
	}
	recordForensicSessionStart(userId, dbFilename);
	watchForRuntimeCorruption(db, userId, dbFilename);
	const previousUserId = activeUserId;
	const alreadyActive = activeUserId === userId;
	activeUserId = userId;
	activeRemoteSync = useRemoteSync;
	if (!useRemoteSync) return;
	if (alreadyActive) return;
	connectChain = connectChain.then(async () => {
		if (previousUserId && previousUserId !== userId) {
			const previousDb = dbsByUser.get(previousUserId);
			if (previousDb) await previousDb.disconnect();
		}
		const resolver = resolverForUser(userId);
		await db.connect(createPowerSyncConnector({
			getWorkspaceMode: resolver.getMode,
			getCek: resolver.getCek
		}));
	}).catch((error) => {
		console.error(`PowerSync background connect failed for ${userId}:`, error);
	});
};
var initializePowerSyncDb = async (powerSyncDb) => {
	await powerSyncDb.init();
	await powerSyncDb.execute("PRAGMA cache_size = -262144");
	await powerSyncDb.execute("PRAGMA temp_store = MEMORY");
	await powerSyncDb.execute(CREATE_BLOCKS_TABLE_SQL);
	await powerSyncDb.execute(CREATE_BLOCKS_SYNCED_TABLE_SQL);
	await powerSyncDb.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL);
	await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL);
	await ensureUndoGroupIdColumns(powerSyncDb);
	await ensureBlockUserUpdatedAtColumn(powerSyncDb);
	await powerSyncDb.execute(CREATE_WORKSPACES_TABLE_SQL);
	await ensureWorkspaceE2eeColumns(powerSyncDb);
	await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL);
	await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL);
	for (const stmt of CLIENT_SCHEMA_STATEMENTS) await powerSyncDb.execute(stmt);
	const backfillDb = {
		execute: guardSyncedTableWrites((sql, params) => powerSyncDb.execute(sql, params)),
		getOptional: async (sql) => {
			return await powerSyncDb.getOptional(sql) ?? null;
		}
	};
	await backfillBlockAliasesIfEmpty(backfillDb);
	await backfillBlockTypesIfEmpty(backfillDb);
	await backfillBlocksFtsIfEmpty(backfillDb);
	await applyLocalSchemaContributions(backfillDb, resolveLocalSchemaContributions(staticDataExtensions));
	const scheduleAnalyzeCheck = (reason) => {
		scheduleIdle(() => {
			runAnalyzeIfStale(backfillDb).catch((error) => {
				console.warn(`[Repo] ANALYZE check failed (${reason}):`, error);
			});
		});
	};
	scheduleAnalyzeCheck("boot");
	if (!powerSyncDb.currentStatus?.hasSynced) onFirstSync(powerSyncDb, () => scheduleAnalyzeCheck("first-sync"));
};
//#endregion
export { closePowerSyncDbIfOpen, dbFilenameForUser, ensurePowerSyncReady, getActiveSyncResolver, getActiveUserId, getPowerSyncDb, isRemoteSyncActive, previewDbSuffix, syncObserverDepsFor, syncResolverForUser };

//# sourceMappingURL=repoProvider.js.map