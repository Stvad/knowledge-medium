/**
 * `createTestRepo` — build a `Repo` over a `createTestDb()` database with the
 * wiring ~90 test files currently hand-roll: a fresh `BlockCache`,
 * deterministic now/newId/newTxSeq counters, a default user, the kernel facet
 * runtime (plus any extra `extensions`), and the Layout B sync observer left
 * OFF by default.
 *
 * Leaving the observer off is the structural fix for the leak most call sites
 * paper over with `afterEach(() => repo.stopSyncObserver())`: the observer
 * holds a live `db.onChange` subscription on the SHARED db, so a per-test Repo
 * that starts it must dispose it or the subscription outlives the test. Unit
 * tests that don't drive sync don't need the observer at all.
 *
 * Pairs with the shared-db pattern (AGENTS.md): one `createTestDb()` in
 * `beforeAll`, `resetTestDb()` in `beforeEach`, a fresh `createTestRepo()` per
 * test for registry / cache / handle-store isolation. For sync-materialization
 * tests, pass `startSyncObserver: true` and stop it in your own cleanup.
 */

import type { User } from '@/data/api/user.js'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension.js'
import { Repo, type RepoOptions } from '@/data/repo'
import { resolveFacetRuntimeSync, type AppExtension } from '@/facets/facet.js'

export interface CreateTestRepoOptions {
  /** The shared PowerSync db from `createTestDb()`. */
  db: RepoOptions['db']
  /** Data extensions to register beyond the always-present kernel. When
   *  provided, the Repo's facet runtime is set to
   *  `[kernelDataExtension, ...extensions]`; when omitted, the Repo keeps the
   *  kernel-only runtime it installs at construction. */
  extensions?: readonly AppExtension[]
  /** Acting user. Default `{ id: 'test-user' }` (matches the factory default). */
  user?: User
  /** Start the Layout B sync observer. Default FALSE — see the module doc. */
  startSyncObserver?: boolean
  /** Reject `BlockDefault` / `References` writes (read-only mode). Default false. */
  isReadOnly?: boolean
  /** Override the deterministic generators. Defaults are monotonic counters so
   *  timestamps, ids, and tx-seqs are stable and ordered across a test. */
  now?: () => number
  newId?: () => string
  newTxSeq?: () => number
}

export interface TestRepo {
  repo: Repo
  /** The `BlockCache` the Repo was built with (handy for cache-behavior tests). */
  cache: BlockCache
}

export const createTestRepo = (opts: CreateTestRepoOptions): TestRepo => {
  const cache = new BlockCache()
  let timeCursor = 1_700_000_000_000
  let idCursor = 0
  let txSeqCursor = 0
  const repo = new Repo({
    db: opts.db,
    cache,
    user: opts.user ?? { id: 'test-user' },
    now: opts.now ?? (() => ++timeCursor),
    newId: opts.newId ?? (() => `gen-${++idCursor}`),
    newTxSeq: opts.newTxSeq ?? (() => ++txSeqCursor),
    isReadOnly: opts.isReadOnly,
    startSyncObserver: opts.startSyncObserver ?? false,
  })
  if (opts.extensions?.length) {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension, ...opts.extensions]))
  }
  return { repo, cache }
}
