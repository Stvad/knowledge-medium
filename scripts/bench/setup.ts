/**
 * Per-suite test-repo setup. Mirrors `src/data/test/createTestDb.ts` but
 * exposes the optional db instrumentation for roundtrip counting.
 *
 * Each call:
 *   - mints a tmpdir + opens a real `@powersync/node` PowerSyncDatabase,
 *   - applies the production blocks raw-table + v2 client schema,
 *   - constructs a `Repo` (kernel mutators registered by default),
 *   - returns the bundle with a `cleanup` to remove the tmpdir.
 *
 * The bench suites accept `instrumented: true` to wrap the db in the
 * counter from `harness.ts` BEFORE handing it to Repo — so calls inside
 * mutators count too.
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
  CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL,
} from '@/data/blockSchema'
import { CLIENT_SCHEMA_STATEMENTS } from '@/data/internals/clientSchema'
import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/internals/repo'
import type { PowerSyncDb } from '@/data/internals/commitPipeline'
import { instrumentDb, type DbCounters } from './harness'

export interface BenchEnv {
  db: PowerSyncDb
  /** Counters; only meaningful when `instrumented: true`. */
  counters: DbCounters | null
  cache: BlockCache
  repo: Repo
  cleanup: () => Promise<void>
}

export interface SetupOptions {
  instrumented?: boolean
  /** Skip kernel processors (parseReferences). Default true — bench
   *  doesn't want async follow-up txs polluting timings. */
  skipProcessors?: boolean
  /** Disable the row_events tail subscription. Default true — bench
   *  measures the engine fast path; the tail's throttle window adds
   *  noise. Suites that explicitly bench the tail re-enable it. */
  skipRowEventsTail?: boolean
}

export const setupBenchEnv = async (opts: SetupOptions = {}): Promise<BenchEnv> => {
  const schema = new Schema({})
  schema.withRawTables({blocks: BLOCKS_RAW_TABLE})

  const dbDir = mkdtempSync(join(tmpdir(), 'bench-'))
  const psDb = new PowerSyncDatabase({
    schema,
    database: {dbFilename: 'bench.db', dbLocation: dbDir},
  })
  await psDb.waitForReady()

  await psDb.execute(CREATE_BLOCKS_TABLE_SQL)
  await psDb.execute(CREATE_BLOCKS_PARENT_ORDER_INDEX_SQL)
  await psDb.execute(CREATE_BLOCKS_WORKSPACE_ACTIVE_INDEX_SQL)
  await psDb.execute(CREATE_BLOCKS_WORKSPACE_REFERENCES_INDEX_SQL)
  for (const stmt of CLIENT_SCHEMA_STATEMENTS) await psDb.execute(stmt)

  let dbForRepo: PowerSyncDb = psDb as unknown as PowerSyncDb
  let counters: DbCounters | null = null
  if (opts.instrumented) {
    const w = instrumentDb(dbForRepo)
    dbForRepo = w.db
    counters = w.counters
  }

  const cache = new BlockCache()
  const repo = new Repo({
    db: dbForRepo,
    cache,
    user: {id: 'bench-user'},
    registerKernelProcessors: !(opts.skipProcessors ?? true),
    startRowEventsTail: !(opts.skipRowEventsTail ?? true),
  })

  return {
    db: dbForRepo,
    counters,
    cache,
    repo,
    cleanup: async () => {
      repo.stopRowEventsTail()
      await psDb.close()
      rmSync(dbDir, {recursive: true, force: true})
    },
  }
}
