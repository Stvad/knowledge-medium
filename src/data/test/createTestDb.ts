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
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PowerSyncDatabase, Schema } from '@powersync/node'
import {
  BLOCKS_SYNCED_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_SYNCED_TABLE_SQL,
  CREATE_BLOCKS_FIELD_FORM_INDEX_SQL,
  CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  ensureBlockLocalColumns,
} from '@/data/blockSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  RECONCILE_RESCAN_MARKER_PREFIX,
  REPROJECT_REF_MARKER_PREFIX,
  WORKSPACE_BACKFILL_MARKER_PREFIX,
  backfillBlockAliasesIfEmpty,
  backfillBlocksFtsIfEmpty,
  backfillBlockTypesIfEmpty,
} from '@/data/internals/clientSchema'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.js'
import {
  CREATE_WORKSPACES_TABLE_SQL,
  CREATE_WORKSPACE_MEMBERS_INDEX_SQL,
  CREATE_WORKSPACE_MEMBERS_TABLE_SQL,
  WORKSPACES_RAW_TABLE,
  WORKSPACE_MEMBERS_RAW_TABLE,
} from '@/data/workspaceSchema'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.js'

export interface TestDb {
  /** The real PowerSync database — same type as production. */
  db: PowerSyncDatabase
  /** Tear down: closes the db and removes the per-test tmpdir. Call from
   *  `afterAll` or `afterEach`. Idempotent. */
  cleanup: () => Promise<void>
}

const localSchemaContributions = resolveLocalSchemaContributions(staticDataExtensions)

const createTestSchema = (): Schema => {
  const schema = new Schema({})
  // Layout B (design doc §9.2): production maps only `blocks_synced` as a raw
  // table — `blocks` is a plain local table the observer materializes into —
  // so the harness mirrors that. Tests drive sync by writing `blocks_synced`
  // and running the observer / `materializeStagingRows`.
  schema.withRawTables({
    blocks_synced: BLOCKS_SYNCED_RAW_TABLE,
    workspaces: WORKSPACES_RAW_TABLE,
    workspace_members: WORKSPACE_MEMBERS_RAW_TABLE,
  })
  return schema
}

const openTestDb = async (dbDir: string): Promise<PowerSyncDatabase> => {
  const schema = createTestSchema()
  const db = new PowerSyncDatabase({
    schema,
    database: {dbFilename: 'test.db', dbLocation: dbDir},
  })
  await db.waitForReady()
  return db
}

const initializeTestDb = async (dbDir: string): Promise<PowerSyncDatabase> => {
  const db = await openTestDb(dbDir)
  // PowerSync's RawTable mapping does not auto-create the local SQLite
  // table — production runs the DDL itself in `repoProvider.ts`. We
  // mirror that ordering: blocks table + indexes first, then the
  // client-schema add-ons (auxiliary tables + triggers).
  await db.execute(CREATE_BLOCKS_TABLE_SQL)
  await db.execute(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  await db.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await db.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  // No-op on a fresh table (CREATE carries the local columns) — mirrors the
  // production upgrade ordering so the harness exercises the same path.
  await ensureBlockLocalColumns(db)
  await db.execute(CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL)
  await db.execute(CREATE_BLOCKS_FIELD_FORM_INDEX_SQL)
  await db.execute(CREATE_WORKSPACES_TABLE_SQL)
  await db.execute(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  await db.execute(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await db.execute(stmt)
  }
  // No-op against a fresh test DB (no blocks yet), but mirrors the
  // production startup ordering so any test that pre-seeds rows
  // before the harness opens still gets backfilled.
  const backfillDb = {
    execute: (sql: string, params?: unknown[]) => db.execute(sql, params as never[] | undefined),
    getOptional: async <T,>(sql: string) => {
      const row = await db.getOptional<T>(sql)
      return row ?? null
    },
  }
  await backfillBlockAliasesIfEmpty(backfillDb)
  await backfillBlockTypesIfEmpty(backfillDb)
  await backfillBlocksFtsIfEmpty(backfillDb)
  await applyLocalSchemaContributions(
    backfillDb,
    localSchemaContributions,
  )

  return db
}

let templateDbDirPromise: Promise<string> | null = null
const TEMPLATE_READY_FILE = '.ready'

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

const getTemplateFingerprint = (): string => {
  const hash = createHash('sha256')
  hash.update(process.cwd())
  hash.update('\0')
  hash.update(CREATE_BLOCKS_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_SYNCED_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_REFERENCE_TARGET_PARENT_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_BLOCKS_FIELD_FORM_INDEX_SQL)
  hash.update('\0')
  hash.update(CREATE_WORKSPACES_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_WORKSPACE_MEMBERS_TABLE_SQL)
  hash.update('\0')
  hash.update(CREATE_WORKSPACE_MEMBERS_INDEX_SQL)
  hash.update('\0')
  hash.update(CLIENT_SCHEMA_STATEMENTS.join('\0'))
  hash.update('\0')
  hash.update(JSON.stringify(localSchemaContributions.map(contribution => ({
    statements: contribution.statements ?? [],
    triggerNames: contribution.triggerNames ?? [],
  }))))
  return hash.digest('hex').slice(0, 20)
}

const waitForTemplateReadyOrLockRelease = async (
  templateDir: string,
  lockDir: string,
): Promise<boolean> => {
  const readyFile = join(templateDir, TEMPLATE_READY_FILE)
  const startedAt = Date.now()
  while (!existsSync(readyFile)) {
    if (!existsSync(lockDir)) return false
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
 *  raw-table + the v2 client schema applied. */
export const createTestDb = async (): Promise<TestDb> => {
  const templateDir = await ensureTemplateDbDir()
  const dbDir = mkdtempSync(join(tmpdir(), 'ps-test-'))
  copyTemplateDb(templateDir, dbDir)
  const db = await openTestDb(dbDir)

  return {
    db,
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
] as const
const RESET_AUDIT_TABLES = ['row_events', 'command_events', 'ps_crud', 'ps_crud_rejected'] as const

/**
 * Truncate all test data from a `createTestDb` database and reset
 * `tx_context`, returning it to the same empty state a freshly-opened
 * harness has — ~100x cheaper than opening a new PowerSyncDatabase
 * (~2.5ms vs ~260ms). Use with one `beforeAll` open + `afterAll` close and
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
    // Clear per-test dynamic markers — reprojection (schema-swap catch-up) and
    // workspace backfills — so each is re-detected per test. A freshly-opened
    // harness has none of these; we keep only the alias/type/FTS/ANALYZE
    // markers from template init.
    if (present.has('client_schema_state')) {
      await tx.execute(
        `DELETE FROM client_schema_state WHERE key LIKE '${REPROJECT_REF_MARKER_PREFIX}%'`,
      )
      await tx.execute(
        `DELETE FROM client_schema_state WHERE key LIKE '${WORKSPACE_BACKFILL_MARKER_PREFIX}%'`,
      )
      await tx.execute(
        `DELETE FROM client_schema_state WHERE key LIKE '${RECONCILE_RESCAN_MARKER_PREFIX}%'`,
      )
    }
    // Restart AUTOINCREMENT counters (e.g. ps_crud.id) so per-test row-id
    // expectations stay stable.
    if (present.has('sqlite_sequence')) await tx.execute('DELETE FROM sqlite_sequence')
  })
}
