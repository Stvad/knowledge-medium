/**
 * Per-suite test-repo setup. Mirrors `src/data/test/createTestDb.ts` but
 * exposes the optional db instrumentation for roundtrip counting.
 *
 * Each call:
 *   - mints a tmpdir + opens the same SQLite test harness used by data tests,
 *   - applies the production tables + v2 client schema,
 *   - constructs a `Repo` (kernel mutators registered by default),
 *   - returns the bundle with a `cleanup` to remove the tmpdir.
 *
 * The bench suites accept `instrumented: true` to wrap the db in the
 * counter from `harness.ts` BEFORE handing it to Repo — so calls inside
 * mutators count too.
 */

import { BlockCache } from '@/data/blockCache'
import { Repo } from '@/data/internals/repo'
import type { LocalDb } from '@/data/internals/commitPipeline'
import { createTestDb } from '@/data/test/createTestDb'
import { instrumentDb, type DbCounters } from './harness'

export interface BenchEnv {
  db: LocalDb
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
  const testDb = await createTestDb()
  let dbForRepo: LocalDb = testDb.db
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
      await testDb.cleanup()
    },
  }
}
