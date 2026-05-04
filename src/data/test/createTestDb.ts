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

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PowerSyncDatabase, Schema } from '@powersync/node'
import {
  BLOCKS_RAW_TABLE,
  CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL,
  CREATE_BLOCKS_TABLE_SQL,
  CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL,
  CREATE_BLOCKS_WORKSPACE_TYPE_INDEX_SQL,
} from '@/data/blockSchema'
import {
  CLIENT_SCHEMA_STATEMENTS,
  backfillBlockAliasesIfEmpty,
} from '@/data/internals/clientSchema'
import {
  applyLocalSchemaContributions,
  resolveLocalSchemaContributions,
} from '@/data/localSchema.ts'
import { staticDataExtensions } from '@/extensions/staticDataExtensions.ts'

export interface TestDb {
  /** The real PowerSync database — same type as production. */
  db: PowerSyncDatabase
  /** Tear down: closes the db and removes the per-test tmpdir. Call from
   *  `afterAll` or `afterEach`. Idempotent. */
  cleanup: () => Promise<void>
}

/** Open an in-tmpdir PowerSyncDatabase with the production blocks
 *  raw-table + the v2 client schema applied. */
export const createTestDb = async (): Promise<TestDb> => {
  const schema = new Schema({})
  schema.withRawTables({blocks: BLOCKS_RAW_TABLE})

  const dbDir = mkdtempSync(join(tmpdir(), 'ps-test-'))
  const db = new PowerSyncDatabase({
    schema,
    database: {dbFilename: 'test.db', dbLocation: dbDir},
  })
  await db.waitForReady()

  // PowerSync's RawTable mapping does not auto-create the local SQLite
  // table — production runs the DDL itself in `repoProvider.ts`. We
  // mirror that ordering: blocks table + indexes first, then the
  // client-schema add-ons (auxiliary tables + triggers).
  await db.execute(CREATE_BLOCKS_TABLE_SQL)
  await db.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await db.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  await db.execute(CREATE_BLOCKS_WORKSPACE_TYPE_INDEX_SQL)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) {
    await db.execute(stmt)
  }
  // No-op against a fresh test DB (no blocks yet), but mirrors the
  // production startup ordering so any test that pre-seeds rows
  // before the harness opens still gets backfilled.
  const backfillDb = {
    execute: (sql: string) => db.execute(sql),
    getOptional: async <T,>(sql: string) => {
      const row = await db.getOptional<T>(sql)
      return row ?? null
    },
  }
  await backfillBlockAliasesIfEmpty(backfillDb)
  await applyLocalSchemaContributions(
    backfillDb,
    resolveLocalSchemaContributions(staticDataExtensions),
  )

  return {
    db,
    cleanup: async () => {
      await db.close()
      rmSync(dbDir, {recursive: true, force: true})
    },
  }
}
