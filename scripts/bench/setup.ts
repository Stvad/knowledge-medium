/**
 * Per-suite test-repo setup, on the maintained Layout B harness.
 *
 * Resurrected (per the `tsconfig.scripts.json` note) against
 * `@/data/test/createTestDb`: the same real `@powersync/node` database the
 * data-layer unit tests run on (production raw-table mapping for
 * `blocks_synced` + the v2 client schema; `blocks` is a plain local table).
 * The bench writes test data straight into `blocks` (via `fixtures.ts`) and
 * reads through the live `Repo`, so it exercises the production query path
 * without standing up sync.
 *
 * Each call:
 *   - opens a fresh `createTestDb()` (template-cached, ~2.5ms warm),
 *   - optionally wraps the db in the roundtrip counter from `harness.ts`
 *     BEFORE handing it to `Repo` (so calls inside mutators/queries count),
 *   - constructs a `Repo` with the kernel runtime installed (so
 *     `repo.query.childIds` / `repo.mutate['core.setContent']` resolve) and
 *     the sync observer OFF (the bench measures the engine fast path, not
 *     sync drain),
 *   - returns the bundle with a `cleanup` that closes the db + removes the
 *     tmpdir.
 */

import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/repo'
import { createTestDb } from '@/data/test/createTestDb'
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
}

export const setupBenchEnv = async (opts: SetupOptions = {}): Promise<BenchEnv> => {
  const testDb = await createTestDb()

  let dbForRepo: PowerSyncDb = testDb.db as unknown as PowerSyncDb
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
    // Kernel queries/mutators (childIds, subtree, setContent, …) registered
    // via the default kernel-runtime install. Sync observer off — the bench
    // writes directly to `blocks` and measures the engine, not the drain.
    startSyncObserver: false,
  })

  return {
    db: dbForRepo,
    counters,
    cache,
    repo,
    cleanup: async () => {
      await testDb.cleanup()
    },
  }
}
