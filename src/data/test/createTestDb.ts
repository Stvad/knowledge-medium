/**
 * Real-PowerSync test harness for the data-layer redesign.
 *
 * Spins up an actual `@powersync/node` `PowerSyncDatabase` with the
 * production raw-table mapping and the v2 client schema. Tests for
 * `Repo` / `Tx` / tree CTEs run against this — same `db.execute` /
 * `db.writeTransaction` surface as production, same SQLite engine
 * semantics, same triggers and side indexes.
 *
 * Why @powersync/node and not node:sqlite + adapter:
 *   The Tx engine relies on `db.writeTransaction(fn)` semantics — locking,
 *   queueing, rollback-on-throw — that PowerSync's wrapper provides.
 *   Mocking that with our own adapter would make tests pass against a
 *   subtly different contract than production. @powersync/node is the
 *   officially-supported Node story; better-sqlite3 underneath gives us
 *   real SQLite, and the wrapper is identical to @powersync/web's.
 *
 * Why a real file (not :memory:):
 *   @powersync/node spawns worker threads for reads (writer + ≥1 reader).
 *   :memory: gives each worker its own private DB, so reads see an empty
 *   schema. A per-test tmpdir is the supported pattern.
 */

import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PowerSyncDatabase } from '@powersync/node'
import Database from 'better-sqlite3'
import {
  createClientPowerSyncSchema,
  initializeClientDatabase,
  initializeClientSchema,
} from '@/data/internals/initializeClientDatabase.js'
import {
  CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_NEEDS_APPLY_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,
  CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL,
  dropStaleAnyFieldFormIndex,
  CREATE_BLOCKS_REFERENCE_CANDIDATES_INDEX_SQL,
  CREATE_BLOCKS_BEING_EDITED_INDEX_SQL,
  CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  RECONCILE_FLAGS_TRUSTED_MARKER_PREFIX,
  RECONCILE_RESCAN_MARKER_PREFIX,
  REPROJECT_REF_MARKER_PREFIX,
  WORKSPACE_BACKFILL_MARKER_PREFIX,
  WORKSPACE_FIRST_SYNC_MARKER_PREFIX,
} from '@/data/internals/clientSchema'
import {
  resolveLocalSchemaContributions,
} from '@/data/localSchema.js'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
} from '@/data/workspaceSchema'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'

// Keep the native addon loaded in the parent while PowerSync workers exit.
// better-sqlite3 12 can unload it before V8's final worker GC (#1477 upstream).
new Database(':memory:').close()

export interface TestDb {
  /** The real PowerSync database — same type as production. */
  db: PowerSyncDatabase
  /** Tear down: closes the db and removes the per-test tmpdir. Call from
   *  `afterAll` or `afterEach`. Idempotent. */
  cleanup: () => Promise<void>
}

const localSchemaContributions = resolveLocalSchemaContributions(staticDataExtensions)

const openTestDb = async (dbDir: string): Promise<PowerSyncDatabase> => {
  const db = new PowerSyncDatabase({
    schema: createClientPowerSyncSchema(),
    // One reader preserves WAL isolation; Vitest parallelizes test files.
    database: {dbFilename: 'test.db', dbLocation: dbDir, readWorkerCount: 1},
  })
  await db.waitForReady()
  return db
}

const initializeTestDb = async (dbDir: string): Promise<PowerSyncDatabase> => {
  const db = await openTestDb(dbDir)
  await initializeClientDatabase(db, 'node', {scheduleAnalyzeCheck: () => {}})
  return db
}

let templateDbDirPromise: Promise<string> | null = null
const TEMPLATE_READY_FILE = '.ready'
/** Inside the build lock: the pid of the process building the template. */
const LOCK_OWNER_FILE = 'pid'
/** A lock with no readable owner is a builder between its mkdir and its pid
 *  write, or one killed in that instant. Far above any real build. */
const OWNERLESS_LOCK_STALE_MS = 5 * 60_000

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const getTemplateFingerprint = (): string => {
  const hash = createHash('sha256')
  hash.update(process.cwd())
  hash.update(String(initializeClientSchema))
  hash.update(String(initializeClientDatabase))
  hash.update('\0')
  hash.update(CREATE_BLOCKS_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  hash.update(CREATE_BLOCKS_SYNCED_NEEDS_APPLY_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_PARENT_DELETED_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_WORKSPACE_NONEMPTY_PROPERTIES_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_WORKSPACE_RECENT_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_BEING_EDITED_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_REFERENCE_CANDIDATES_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_FIELD_FORM_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_ANY_FIELD_FORM_INDEX_SQL)
  hash.update(String(dropStaleAnyFieldFormIndex))
  hash.update('\0')
  hash.update(CREATE_WORKSPACES_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)
  hash.update('\0')
  hash.update(CLIENT_SCHEMA_STATEMENTS.join('\0'))
  hash.update('\0')
  // Backfills are part of the schema the template bakes in — several DROP
  // and rebuild their table, so an edit inside a backfill body changes
  // indexes/triggers without touching `statements`; hashing only
  // `statements` would serve a stale cached template forever on a warm
  // /tmp. `run.toString()` is a cheap structural fingerprint of the body.
  hash.update(JSON.stringify(localSchemaContributions.map(contribution => ({
    statements: contribution.statements ?? [],
    triggerNames: contribution.triggerNames ?? [],
    backfills: (contribution.backfills ?? []).map(b => [b.id, b.run.toString()]),
  }))))
  return hash.digest('hex').slice(0, 20)
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Whether the builder holding `lockDir` is gone: killed mid-build (a gate
 *  SIGTERMs vitest when lint fails), so its `finally` never released it. */
const lockAbandoned = (lockDir: string): boolean => {
  let pid = NaN
  try {
    pid = Number(readFileSync(join(lockDir, LOCK_OWNER_FILE), 'utf8'))
  } catch { /* no owner written yet */ }
  if (Number.isInteger(pid) && pid > 0) return !pidAlive(pid)
  try {
    return Date.now() - statSync(lockDir).mtimeMs > OWNERLESS_LOCK_STALE_MS
  } catch {
    return false
  }
}

/** True once the template is ready; false when the lock is free to take,
 *  including one this call stole from a builder that is gone. Two waiters can
 *  both steal it and both build, and the later rename then fails that run
 *  once: accepted over a protocol to prevent a race this rare. */
export const waitForTemplateReadyOrLockRelease = async (
  templateDir: string,
  lockDir: string,
): Promise<boolean> => {
  const readyFile = join(templateDir, TEMPLATE_READY_FILE)
  const startedAt = Date.now()
  while (!existsSync(readyFile)) {
    if (!existsSync(lockDir)) return false
    if (lockAbandoned(lockDir)) {
      rmSync(lockDir, {recursive: true, force: true})
      return false
    }
    if (Date.now() - startedAt > 15_000) {
      throw new Error(`[createTestDb] timed out waiting for template DB at ${templateDir}`)
    }
    await sleep(10)
  }
  return true
}

const ensureTemplateDbDir = async (): Promise<string> => {
  templateDbDirPromise ??= (async () => {
    const cacheDir = join(tmpdir(), 'ps-test-template-cache')
    mkdirSync(cacheDir, {recursive: true})
    const templateDir = join(cacheDir, getTemplateFingerprint())
    const readyFile = join(templateDir, TEMPLATE_READY_FILE)
    if (existsSync(readyFile)) return templateDir

    const lockDir = `${templateDir}.lock`
    for (;;) {
      try {
        mkdirSync(lockDir)
        writeFileSync(join(lockDir, LOCK_OWNER_FILE), String(process.pid))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        if (await waitForTemplateReadyOrLockRelease(templateDir, lockDir)) return templateDir
      }
    }

    const dbDir = mkdtempSync(join(cacheDir, 'building-'))
    let db: PowerSyncDatabase | null = null
    try {
      rmSync(templateDir, {recursive: true, force: true})
      db = await initializeTestDb(dbDir)
      await db.close()
      writeFileSync(join(dbDir, TEMPLATE_READY_FILE), '')
      renameSync(dbDir, templateDir)
      return templateDir
    } catch (error) {
      if (db) await db.close().catch(() => {})
      rmSync(dbDir, {recursive: true, force: true})
      throw error
    } finally {
      rmSync(lockDir, {recursive: true, force: true})
    }
  })()
  return templateDbDirPromise
}

const copyTemplateDb = (templateDir: string, dbDir: string): void => {
  for (const entry of readdirSync(templateDir)) {
    if (entry === TEMPLATE_READY_FILE) continue
    cpSync(join(templateDir, entry), join(dbDir, entry), {recursive: true, force: true})
  }
}

/** Open an in-tmpdir PowerSyncDatabase with the production blocks
 *  raw-table + the v2 client schema applied, or a copy of `from`: the closed
 *  `dir` of an earlier one. */
export const createTestDb = async ({from}: {from?: string} = {}): Promise<TestDb & {
  /** Holds the database files; once `db` is closed, a template another
   *  `createTestDb` can copy. */
  dir: string
}> => {
  const templateDir = from ?? await ensureTemplateDbDir()
  const dbDir = mkdtempSync(join(tmpdir(), 'ps-test-'))
  copyTemplateDb(templateDir, dbDir)
  const db = await openTestDb(dbDir)

  return {
    db,
    dir: dbDir,
    cleanup: async () => {
      await db.close()
      rmSync(dbDir, {recursive: true, force: true})
    },
  }
}

// Data tables cleared by `resetTestDb`, ordered so content/side tables go
// first (their AFTER-DELETE triggers re-touch the side indexes + audit
// tables) and the audit/queue tables go last so trigger-written rows are
// swept too. NOT cleared: `client_schema_state` (backfill markers / schema
// state), `tx_context` (a singleton row — reset via UPDATE), the FTS shadow
// tables (`blocks_fts_*` content/idx/etc. — managed by the `blocks_fts`
// virtual table; touching them directly corrupts the index), and PowerSync's
// own internals (`ps_buckets`, `ps_oplog`, …) except the upload queue.
const RESET_CONTENT_TABLES = [
  'blocks',
  'blocks_synced',
  'blocks_synced_changes',
  'workspaces',
  'workspace_members',
  'block_aliases',
  'block_references',
  'block_types',
  'blocks_fts', // virtual FTS table — DELETE clears its shadow tables safely
  'blocks_fts_rowids',
  'blocks_fts_owed',
] as const
const RESET_AUDIT_TABLES = ['row_events', 'command_events', 'ps_crud', 'ps_crud_rejected'] as const

/**
 * Truncate all test data from a `createTestDb` database and reset
 * `tx_context`, returning it to the same empty state a freshly-opened
 * harness has — far cheaper than opening a new PowerSyncDatabase.
 * Use with one `beforeAll` open + `afterAll` close and
 * a `beforeEach(() => resetTestDb(h.db))`, building a fresh `Repo` per test
 * for registry/cache/handle-store isolation.
 *
 * Only clears tables that actually exist, so it tolerates schema variants
 * (e.g. a plugin's local table that isn't present in a given harness). If a
 * test installs its OWN extra data table, clear it explicitly in the test.
 */
export const resetTestDb = async (db: PowerSyncDatabase): Promise<void> => {
  const present = new Set(
    (await db.getAll<{name: string}>(
      "SELECT name FROM sqlite_master WHERE type='table'",
    )).map(row => row.name),
  )
  const existing = (names: readonly string[]) => names.filter(name => present.has(name))

  await db.writeTransaction(async tx => {
    // Reset routing context first so the content deletes below are treated
    // as non-local (no upload-routing into ps_crud) regardless of what the
    // previous test left behind.
    await tx.execute(
      'UPDATE tx_context SET tx_id = NULL, tx_seq = NULL, user_id = NULL, scope = NULL, source = NULL, group_id = NULL',
    )
    for (const table of existing(RESET_CONTENT_TABLES)) await tx.execute(`DELETE FROM ${table}`)
    for (const table of existing(RESET_AUDIT_TABLES)) await tx.execute(`DELETE FROM ${table}`)
    // Clear the per-test dynamic rows — the catch-up markers and the
    // definitions baseline — so each is re-detected per test. A freshly-opened
    // harness has none of these; we keep only the alias/type/FTS/ANALYZE
    // markers from template init.
    if (present.has('client_schema_state')) {
      for (const prefix of [
        REPROJECT_REF_MARKER_PREFIX,
        WORKSPACE_BACKFILL_MARKER_PREFIX,
        RECONCILE_RESCAN_MARKER_PREFIX,
        RECONCILE_FLAGS_TRUSTED_MARKER_PREFIX,
        WORKSPACE_FIRST_SYNC_MARKER_PREFIX,
      ]) {
        await tx.execute(`DELETE FROM client_schema_state WHERE key LIKE '${prefix}%'`)
      }
    }
    // Restart AUTOINCREMENT counters (e.g. ps_crud.id) so per-test row-id
    // expectations stay stable.
    if (present.has('sqlite_sequence')) await tx.execute('DELETE FROM sqlite_sequence')
  })
}
