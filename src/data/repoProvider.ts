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

import { PowerSyncDatabase, Schema, WASQLiteOpenFactory, WASQLiteVFS } from '@powersync/web'
import { createPowerSyncConnector, hasRemoteSyncConfig } from '@/services/powersync.js'
import { createSyncResolver, type SyncResolver } from '@/sync/keys/resolver.js'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore.js'
import type { MaterializeDeps } from '@/data/internals/syncObserver/materialize.js'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  ensureBlockLocalColumns,
} from '@/data/blockSchema'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  WORKSPACES_RAW_TABLE,
  WORKSPACE_MEMBERS_RAW_TABLE,
  ensureWorkspaceE2eeColumns,
  ensureWorkspacePropertiesMigrationColumn,
} from '@/data/workspaceSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  backfillBlockAliasesIfEmpty,
  backfillBlocksFtsIfEmpty,
  backfillBlockTypesIfEmpty,
  ensureBlockUserUpdatedAtColumn,
  ensureUndoGroupIdColumns,
} from '@/data/internals/clientSchema'
import { runAnalyzeIfStale } from '@/data/maintenance'
import { onFirstSync } from '@/data/internals/firstSync.js'
import { scheduleIdle } from '@/utils/scheduleIdle.js'
import { toLocalDbOpenError } from '@/utils/localDbCorruption.js'
import {
  captureDbOpenCorruption,
  recordForensicSessionStart,
  watchForRuntimeCorruption,
} from '@/utils/dbForensicsHooks.js'
import { releasePowerSyncConnection } from '@/data/releasePowerSyncConnection.js'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.js'
import { guardSyncedTableWrites } from '@/data/syncedTableWriteGuard.js'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'
import {
  dbFilenameForUser,
  recordPreviewDatabaseForReaper,
} from '@/data/localDbStorage.js'

const appSchema = new Schema({})
// Layout B (design doc §9.2): PowerSync writes EVERY downloaded block — the
// `blocks_synced` row_type emitted by the sync rules — into the raw
// `blocks_synced` staging table; the Repo's sync observer then decrypts/copies
// each into the app-visible plaintext `blocks` table. So `blocks` is NOT a raw
// table here — it's a plain local table the observer owns. During the dual-run
// window the sync rules still also emit a plain `blocks` row_type for old
// clients; this client has no raw mapping for it, so PowerSync stashes it in
// `ps_untyped` and ignores it.
appSchema.withRawTables({
  blocks_synced: BLOCKS_SYNCED_RAW_TABLE,
  workspaces: WORKSPACES_RAW_TABLE,
  workspace_members: WORKSPACE_MEMBERS_RAW_TABLE,
})

const dbsByUser = new Map<string, PowerSyncDatabase>()
const initPromises = new Map<string, Promise<void>>()
let activeUserId: string | null = null
// Whether the ACTIVE session connects to remote (vs local-only mode). Set alongside
// activeUserId in ensurePowerSyncReady; read by the attachment up-lane + resolver so a
// local-only session makes NO Supabase Storage request — the same "no remote requests
// in local-only" contract this module already upholds for the PowerSync connect below.
let activeRemoteSync = false
let connectChain: Promise<void> = Promise.resolve()

// One §6 sync resolver per user, shared by both halves of the Layout B
// seam: the upload connector (encrypt-on-upload) and the Repo's download
// observer (materializability + key lookup). Built here so the Repo
// bootstrap (context/repo.tsx) doesn't re-derive a second resolver against
// the same shared key store + mode pins.
const syncResolversByUser = new Map<string, SyncResolver>()
const resolverForUser = (userId: string): SyncResolver => {
  let resolver = syncResolversByUser.get(userId)
  if (!resolver) {
    resolver = createSyncResolver(() => userId, getWorkspaceKeyStore())
    syncResolversByUser.set(userId, resolver)
  }
  return resolver
}

/** The active user id (whose per-user PowerSync DB is mounted), or null when
 *  signed out. The asset byte path (§7.3) scopes its OPFS store + resolver to
 *  this — re-read at call time so an account switch is reflected.
 *
 *  @ambient allowIn: src/data/repoProvider.ts, src/plugins/attachments/assetUpload.ts, src/plugins/attachments/assetResolver.ts
 *  @ambientMessage getActiveUserId() reads the ambient active-user global. Use the injected channel instead: repo.user.id (a Repo/Block is already in scope at every call site) or useUser() in a component.
 */
export const getActiveUserId = (): string | null => activeUserId

/** Whether the active session has remote sync ENABLED (vs local-only). The attachment
 *  up-lane + resolver gate on this so a local-only session uploads/fetches NOTHING
 *  to/from Supabase Storage — `supabase` being non-null only means auth is CONFIGURED,
 *  not that this session opted into remote. */
export const isRemoteSyncActive = (): boolean => activeRemoteSync

/** The active user's §6 sync resolver (materializability / WK / K_id), or null
 *  when signed out. The in-thread asset resolver delegates its decode + content-
 *  key decisions to it, so they share the one §6 policy source. */
export const getActiveSyncResolver = (): SyncResolver | null =>
  activeUserId ? resolverForUser(activeUserId) : null

/** The §6 sync resolver for a SPECIFIC user (materializability / WK / K_id),
 *  regardless of who is active. The byte up-lane binds this at its entry boundary
 *  (capture / drain) so an operation initiated for one user can't read another
 *  user's keys if the active account switches mid-flight. (The read-path asset
 *  resolver legitimately follows the ACTIVE user instead — see assetResolver.ts.) */
export const syncResolverForUser = (userId: string): SyncResolver => resolverForUser(userId)

/** Observer deps for the Repo's `syncObserverDeps` parameter, drawn from
 *  the same per-user resolver the upload connector uses — so download
 *  (decrypt/copy/defer) and upload (encrypt) share one §6 policy source. */
export const syncObserverDepsFor = (
  userId: string,
): MaterializeDeps => {
  const resolver = resolverForUser(userId)
  return {
    getMaterializability: resolver.getMaterializability,
    getCek: resolver.getCek,
  }
}

// Firefox and Safari block OPFS in private browsing — `getDirectory()`
// throws SecurityError. Probe once and surface a useful message before
// PowerSync gets to fail with the opaque internal error.
let opfsProbe: Promise<void> | null = null
const assertOpfsAvailable = (): Promise<void> => {
  if (!opfsProbe) {
    opfsProbe = (async () => {
      try {
        await navigator.storage.getDirectory()
      } catch (err) {
        if (err instanceof DOMException && err.name === 'SecurityError') {
          throw new Error(
            'This browser is blocking local storage access (OPFS), which Knowledge Medium needs to keep your data on this device. ' +
            'This usually means you\'re in private/incognito browsing on Firefox or Safari, where OPFS is disabled. ' +
            'Try a regular (non-private) window, or use Chrome — Chrome incognito allows OPFS.',
            {cause: err},
          )
        }
        throw err
      }
    })()
  }
  return opfsProbe
}

// OPFSCoopSyncVFS gives fast sync access handles (much faster than IDB
// transactions); enableMultiTabs lets the SharedSync worker coordinate
// one sync stream across all open tabs of the same workspace.
const buildPowerSyncDb = (userId: string) => new PowerSyncDatabase({
  schema: appSchema,
  database: new WASQLiteOpenFactory({
    dbFilename: dbFilenameForUser(userId),
    vfs: WASQLiteVFS.OPFSCoopSyncVFS,
  }),
  flags: {
    enableMultiTabs: true,
  },
})

export const getPowerSyncDb = (userId: string): PowerSyncDatabase => {
  const existing = dbsByUser.get(userId)
  if (existing) return existing
  const db = buildPowerSyncDb(userId)
  dbsByUser.set(userId, db)
  return db
}

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
export const closePowerSyncDbIfOpen = async (userId: string): Promise<void> => {
  const existing = dbsByUser.get(userId)
  dbsByUser.delete(userId)
  initPromises.delete(userId)
  if (!existing) return
  await releasePowerSyncConnection(existing)
}

// `useRemoteSync` is the runtime gate (defaults to the build-time
// `hasRemoteSyncConfig`). Callers pass `false` when the user opted into
// local-only mode at login — in that case we still init the local DB +
// triggers but skip `db.connect()` so we never make a Supabase auth or
// PowerSync sync request from this session.
export const ensurePowerSyncReady = async (
  userId: string,
  useRemoteSync: boolean = hasRemoteSyncConfig,
) => {
  await assertOpfsAvailable()

  const dbFilename = dbFilenameForUser(userId)
  await recordPreviewDatabaseForReaper(dbFilename)
  const db = getPowerSyncDb(userId)

  let initPromise = initPromises.get(userId)
  if (!initPromise) {
    initPromise = initializePowerSyncDb(db)
    initPromises.set(userId, initPromise)
  }
  try {
    await initPromise
  } catch (error) {
    // A corrupt local `.db` surfaces here (e.g. "database disk image is
    // malformed"). Record a forensic snapshot (issue #284) BEFORE anything
    // touches the file, then re-throw as a typed, recoverable error carrying the
    // userId so the bootstrap error boundary can offer Export + Reset. Any other
    // failure passes through unchanged.
    captureDbOpenCorruption(userId, dbFilename, error)
    throw toLocalDbOpenError(error, userId)
  }

  // Out-of-band forensic instrumentation (issue #284): record the session (with
  // unclean-shutdown detection), schedule an idle zero-page scan, and watch for
  // a RUNTIME sync-apply corruption the DB-open detector never sees. All
  // best-effort — guarded to run once per process, never throws into boot.
  recordForensicSessionStart(userId, dbFilename)
  watchForRuntimeCorruption(db, userId, dbFilename)

  // The local DB is now mounted for this user — record it as the active account in
  // BOTH modes. The asset byte path (§7.3) + media capture key off getActiveUserId,
  // so a local-only session must still set it or every image/file paste reaches
  // captureMedia as `no-user` and is silently dropped. Only the REMOTE connect
  // below is gated on useRemoteSync.
  const previousUserId = activeUserId
  const alreadyActive = activeUserId === userId
  activeUserId = userId
  // Record the session's mode for the asset lane (set in BOTH modes, like activeUserId).
  activeRemoteSync = useRemoteSync

  if (!useRemoteSync) {
    return
  }

  if (alreadyActive) {
    return
  }

  // Run disconnect+connect serially so we don't race two connect
  // attempts. Don't await the chain — connect can take a while and
  // we want render to proceed against the local cache.
  connectChain = connectChain
    .then(async () => {
      if (previousUserId && previousUserId !== userId) {
        const previousDb = dbsByUser.get(previousUserId)
        if (previousDb) {
          await previousDb.disconnect()
        }
      }
      // Encrypt-on-upload (§9.2): bind the connector's mode/key lookups to this
      // user's mode pins + shared workspace-key store. Plaintext workspaces
      // resolve mode 'none' (no-op); e2ee workspaces seal content columns. Same
      // per-user resolver the observer deps draw from (`syncObserverDepsFor`).
      const resolver = resolverForUser(userId)
      await db.connect(createPowerSyncConnector({
        getWorkspaceMode: resolver.getMode,
        getCek: resolver.getCek,
      }))
    })
    .catch((error) => {
      console.error(`PowerSync background connect failed for ${userId}:`, error)
    })
}

const initializePowerSyncDb = async (powerSyncDb: PowerSyncDatabase) => {
  await powerSyncDb.init()

  // No `PRAGMA journal_mode=WAL`: none of wa-sqlite's PowerSync-bundled
  // VFSes implement xShmMap (the wal-index shared-memory primitive
  // SQLite needs for native WAL), so SQLite silently keeps rollback
  // journal mode. Re-evaluate if PowerSync ever ships a WAL-capable
  // browser VFS.

  // Cache + temp-store tuning. SQLite's default `cache_size` is 2000
  // pages = ~8 MB — fine for tiny DBs, catastrophic for users with
  // import-heavy workspaces (250k blocks ≈ 700 MB on-disk). Each cold
  // page becomes a synchronous OPFS read on the worker thread, so a
  // page-open's load + ancestors + children + backlinks queries all
  // serialize behind cold-page I/O. Raising the cache to 256 MiB lets
  // the hot index + active-page footprint live in worker RAM, dropping
  // most reads to memory speed after a brief warmup.
  //
  // Negative value = absolute KiB (positive = page count, which depends
  // on page_size). 262144 KiB = 256 MiB.
  //
  // Trade: ~256 MiB resident browser memory while the app is open. On
  // small DBs SQLite only allocates pages it touches, so steady-state
  // memory tracks the actual working set (much less than the cap).
  //
  // `temp_store = MEMORY` keeps temp B-trees (DISTINCT, ORDER BY,
  // recursive CTEs) off OPFS — they're transient and don't need to
  // survive a crash, and the OPFS VFS doesn't perform well as a temp
  // store anyway.
  await powerSyncDb.execute('PRAGMA cache_size = -262144')
  await powerSyncDb.execute('PRAGMA temp_store = MEMORY')

  // ── blocks + its indexes ──
  await powerSyncDb.execute(CREATE_BLOCKS_TABLE_SQL)
  // Layout B staging table (§9.2). The raw-table mapping above tells
  // PowerSync how to write it, but does NOT create the local SQLite table —
  // we run the DDL ourselves, same as `blocks`. This is the live landing zone
  // for the `blocks_synced` sync stream; the Repo's observer materializes it
  // into `blocks`.
  await powerSyncDb.execute(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await powerSyncDb.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  // Idempotent local migration: add the LOCAL-only derived columns
  // (`reference_target_id`) to an existing `blocks` table. MUST run before
  // the CLIENT_SCHEMA_STATEMENTS loop below — the recreated row_events
  // trigger bodies reference the column (SQLite accepts a CREATE TRIGGER
  // against a missing column and only fails at fire time). `blocks_synced`
  // deliberately does NOT get it (never synced; PR #288 §11 slice A). The
  // index is created after so it exists on upgrading devices too.
  await ensureBlockLocalColumns(powerSyncDb)
  await powerSyncDb.execute(CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL)
  // Idempotent local migration: add `group_id` to an existing
  // tx_context / row_events (undo grouping, issue #306). MUST run
  // before ANY re-creation of the row_events trigger bodies — that
  // includes `withTriggerSuspended` inside `ensureBlockUserUpdatedAtColumn`
  // below (its backfill bracket re-installs blocks_row_event_update
  // from the NEW constant, whose body references group_id), not just
  // the CLIENT_SCHEMA_STATEMENTS loop. Fresh DBs skip it (tables don't
  // exist yet; the CREATEs carry the column).
  await ensureUndoGroupIdColumns(powerSyncDb)
  // Idempotent local migration: add `user_updated_at` to an existing
  // `blocks` / `blocks_synced` on upgrading devices (CREATE TABLE IF NOT
  // EXISTS above is a no-op when the table already exists) + one-shot
  // backfill. See hydration-staleness-fix-handoff.md step 3.
  await ensureBlockUserUpdatedAtColumn(powerSyncDb)

  // ── workspaces + workspace_members ──
  await powerSyncDb.execute(CREATE_WORKSPACES_TABLE_SQL)
  // Idempotent local migration: add the E2EE columns to an existing
  // `workspaces` table on upgrading devices (CREATE TABLE IF NOT EXISTS
  // above is a no-op when the table already exists). §7 / e2ee-design.
  await ensureWorkspaceE2eeColumns(powerSyncDb)
  // Properties-as-blocks rollout lever (PR #288 §6) — nullable; absence
  // reads as 'cell' (dormant) via parseWorkspaceRow.
  await ensureWorkspacePropertiesMigrationColumn(powerSyncDb)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await powerSyncDb.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)

  // ── tx_context, row_events, command_events, block_aliases + core
  // triggers ── (5 audit/upload, 2 workspace-invariant, 3 alias-index.)
  // Statements include
  // CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS / CREATE
  // TRIGGER IF NOT EXISTS so re-running is a no-op against an
  // already-bootstrapped dev database. (`ensureUndoGroupIdColumns`
  // already ran above, so the recreated trigger bodies can reference
  // row_events.group_id.)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await powerSyncDb.execute(stmt)
  }

  // One-shot side-index backfills for users upgrading from a
  // pre-index schema. Steady-state startups noop on a single LIMIT 1
  // probe of `client_schema_state`.
  const backfillDb = {
    // Guarded: a LocalSchema statement/backfill that raw-writes a synced table
    // (blocks/workspaces/workspace_members) leaves tx_context.source = NULL, so
    // the upload trigger never fires and the write is local-only — it silently
    // never syncs. The guard turns that class into a loud throw. Synced-table
    // backfills must go through repo.tx (workspaceBackfillsFacet).
    execute: guardSyncedTableWrites((sql: string, params?: unknown[]) =>
      powerSyncDb.execute(sql, params as never[] | undefined)),
    getOptional: async <T,>(sql: string) => {
      const row = await powerSyncDb.getOptional<T>(sql)
      return row ?? null
    },
  }
  await backfillBlockAliasesIfEmpty(backfillDb)
  await backfillBlockTypesIfEmpty(backfillDb)
  await backfillBlocksFtsIfEmpty(backfillDb)
  await applyLocalSchemaContributions(
    backfillDb,
    resolveLocalSchemaContributions(staticDataExtensions),
  )

  // ANALYZE off the cold-start path. wa-sqlite never auto-populates
  // `sqlite_stat1`, so the planner makes pessimal join-order choices on
  // `blocks` once a workspace is large (a 4-id `json_each` lookup can
  // degenerate to a 4-second scan of the workspace partial index).
  // `runAnalyzeIfStale` re-runs only when the live `blocks` count has
  // drifted from the count the stats were built on (see clientSchema), so
  // a stable workspace pays nothing and a grown one self-corrects. Both
  // the count probe and ANALYZE run on the single SQLite worker, so every
  // trigger below is idle-deferred — never on the first-paint path.
  //
  // (a) Boot: catches anything that changed since the last session — a
  // prior-session import, organic growth, or the legacy "0 0" stats bug.
  const scheduleAnalyzeCheck = (reason: string) => {
    scheduleIdle(() => {
      void runAnalyzeIfStale(backfillDb).catch(error => {
        console.warn(`[Repo] ANALYZE check failed (${reason}):`, error)
      })
    })
  }
  scheduleAnalyzeCheck('boot')

  // (b) First sync of THIS session: a fresh device boots with an empty
  // `blocks`, so (a) skips. Once PowerSync finishes the initial sync and
  // the observer materializes the rows, the table is large and the boot
  // baseline is stale — re-check then so the user gets good plans the same
  // session instead of after a reload. One-shot; disposes after the first
  // `hasSynced`. If the first sync already completed in a prior session,
  // (a) above already covered it, so don't bother registering.
  if (!powerSyncDb.currentStatus?.hasSynced) {
    onFirstSync(powerSyncDb, () => scheduleAnalyzeCheck('first-sync'))
  }
}
