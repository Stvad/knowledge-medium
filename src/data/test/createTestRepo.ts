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
 *
 * Repos built here are registered against their db so `createTestDb`'s cleanup
 * releases them before closing it (see `releaseTestRepos`). A harness that
 * builds its Repo by hand must call `registerTestRepo` to get the same cover —
 * an unregistered pinned Repo is invisible to the release. Either way this
 * covers only the database going away underneath a parked pass; it does NOT
 * make a Repo safe to abandon mid-file. A file whose tests insert
 * `workspace_members` rows must release each test's Repo itself — see
 * `definitionSeeds.test.ts`.
 *
 * CAVEAT — last-write-wins observer tests: the default `now` is a deterministic
 * counter starting at 1.7e12, NOT `Date.now`. A sync-observer test whose
 * last-write-wins gates compare the local `now()` against synced-row timestamps
 * derived from real time can flip its apply decisions under this counter. Such
 * tests should pass `now: Date.now` (or keep a hand-rolled `new Repo`). This
 * bit invalidation/cycleDetection/typedBlockQuery — they stayed on `new Repo`.
 *
 * MNEMONIC IDS — `blockIdPolicy: 'any'`: a production Repo enforces the
 * canonical-lowercase-UUID block-id contract at `tx.create` / `tx.createOrGet`
 * (issue #456, `@/data/blockId`). Test Repos opt out, because the default
 * `newId` mints `gen-1` and call sites seed `'root'` / `'T2'` / `'block-1'` —
 * ids chosen so a failing `expect(childIds).toEqual([...])` is readable at a
 * glance, which 36 hex digits are not. This is the ONE declared relaxation;
 * the guard itself is pinned by `blockId.test.ts`, and its presence on an
 * unconfigured Repo (the shape production builds) by `txEngine.test.ts`. Pass
 * `blockIdPolicy: 'canonical'` for a test that wants the production contract.
 *
 * CAVEAT — multiple Repos over one db: each `createTestRepo()` call gets its OWN
 * fresh `newId`/`newTxSeq` counters (both restart at `gen-1` / 1). Two Repos
 * sharing one db in the same test will therefore mint COLLIDING block ids and
 * tx-seqs. A two-device/convergence test must give at least one Repo distinct
 * generators, e.g. `newId: uuidv4` (see globalState.test.ts / mutators.test.ts).
 */

import type { User } from '@/data/api/user.js'
import { BlockCache } from '@/data/blockCache'
import type { BackfillCompletionClaim } from '@/data/facets'
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
  /** Materialization POLICY for the observer (the §6 mode/key resolver).
   *  Omitted, the Repo falls back to plaintext copy-through with no key; pass
   *  one to exercise a locked/e2ee workspace through the Repo surface. */
  syncObserverDeps?: RepoOptions['syncObserverDeps']
  /** Forward Repo's construction-time kernel runtime install. Default true. */
  installKernelRuntime?: boolean
  /** Override the workspace-backfill sync gate (default: opens immediately). */
  backfillSyncGate?: (cb: () => void) => () => void
  /** Override the migration-completion claim (default: a local stand-in that
   *  writes the same `client_schema_state` keys the marker store used, so tests
   *  can assert on completion without a synced implementation existing). */
  backfillCompletionClaim?: BackfillCompletionClaim
  /** Reject `BlockDefault` / `References` writes (read-only mode). Default false. */
  isReadOnly?: boolean
  /** Override the deterministic generators. Defaults are monotonic counters so
   *  timestamps, ids, and tx-seqs are stable and ordered across a test. */
  now?: () => number
  newId?: () => string
  newTxSeq?: () => number
  /** Block-id shape contract (issue #456). Default `'any'` — see the
   *  module doc's MNEMONIC IDS note. Pass `'canonical'` to exercise a Repo
   *  configured the way production is. */
  blockIdPolicy?: RepoOptions['blockIdPolicy']
}

export interface TestRepo {
  repo: Repo
  /** The `BlockCache` the Repo was built with (handy for cache-behavior tests). */
  cache: BlockCache
}

/** Raw-SQL probe: is the row soft-deleted? Shared by the undo/grouping
 *  tests, which assert "undo removed the block" without trusting the
 *  cache layer they're testing through. */
export const isBlockDeleted = async (repo: Repo, id: string): Promise<boolean> => {
  const row = await repo.db.getOptional<{deleted: number}>(
    'SELECT deleted FROM blocks WHERE id = ?', [id],
  )
  return row?.deleted === 1
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
    // See the MNEMONIC IDS note in the module doc.
    blockIdPolicy: opts.blockIdPolicy ?? 'any',
    newTxSeq: opts.newTxSeq ?? (() => ++txSeqCursor),
    isReadOnly: opts.isReadOnly,
    startSyncObserver: opts.startSyncObserver ?? false,
    syncObserverDeps: opts.syncObserverDeps,
    installKernelRuntime: opts.installKernelRuntime,
    // `createTestDb` opens a real PowerSyncDatabase with no backend
    // connector, so the production gate (connected && !downloading) would
    // never open and every backfill would hang. Default to an immediate
    // gate; tests that exercise the gating itself inject their own.
    backfillSyncGate: opts.backfillSyncGate ?? ((cb) => { cb(); return () => {} }),
    // Production REFUSES without a claim (completion must be recorded once per
    // graph, and no synced store exists yet). Tests get a local stand-in so the
    // runner's own machinery stays exercised; it deliberately does NOT model
    // cross-device visibility, which is the part slice C has to build.
    // `in` rather than `??` so a test can pass `undefined` to mean "none
    // configured" and exercise the refusal, instead of silently getting the stub.
    backfillCompletionClaim: 'backfillCompletionClaim' in opts ? opts.backfillCompletionClaim : {
      // `reclaimCompleted` mirrors the production claim: a recorded completion
      // stops an unattended pass, never a human who asked for one. A stub that
      // ignored it made every operator re-run read as "already done", which is
      // the behaviour under test for anything the pass can miss.
      tryClaim: async (ws: string, id: string, claimOpts?: {reclaimCompleted?: boolean}) =>
        claimOpts?.reclaimCompleted === true
        || (await opts.db.getOptional<{key: string}>(
          'SELECT key FROM client_schema_state WHERE key = ?', [`workspace_backfill:${ws}:${id}`],
        )) === null,
      markComplete: async (ws: string, id: string) => {
        // `client_schema_state` is (key, completed_at) — there is no `value`
        // column, and writing one threw on every call. It went unnoticed
        // because the runner recorded its outcome BEFORE this ran, so a
        // completion that always failed still reported success.
        await opts.db.execute(
          'INSERT OR REPLACE INTO client_schema_state (key, completed_at) VALUES (?, ?)',
          [`workspace_backfill:${ws}:${id}`, Date.now()],
        )
      },
      releaseClaim: async () => {},
    },
  })
  if (opts.extensions?.length) {
    repo.setFacetRuntime(resolveFacetRuntimeSync([kernelDataExtension, ...opts.extensions]))
  }
  registerTestRepo(opts.db, repo)
  return { repo, cache }
}

/** Every Repo built over a given test database, so `createTestDb`'s cleanup can
 *  release them before closing it.
 *
 *  `WeakRef`, not the Repo: a time-bounded deep fuzz run builds one Repo per
 *  property iteration, and holding them all would grow without bound. It also
 *  happens to select exactly the right ones — a Repo with a parked pass is kept
 *  alive by the subscription that pass holds on the db, and one that has been
 *  collected had nothing left to release. */
const reposByDb = new WeakMap<CreateTestRepoOptions['db'], RepoRefs>()

interface RepoRefs {
  refs: Set<WeakRef<Repo>>
  /** Size at which to drop cleared refs — see `registerTestRepo`. */
  sweepAt: number
}

const SWEEP_FLOOR = 64

/** Track a Repo built by hand (`new Repo(...)`) rather than by `createTestRepo`,
 *  so `releaseTestRepos` covers it too. A pinned Repo that never registers is
 *  invisible to the release, and its db closes under the pass it parked.
 *
 *  Collection clears a `WeakRef` but leaves its Set entry, so the set alone
 *  would still grow with the iteration count of a deep fuzz run. Sweep the
 *  cleared ones on a doubling watermark: amortized O(1) per registration. */
export const registerTestRepo = (db: CreateTestRepoOptions['db'], repo: Repo): void => {
  const entry = reposByDb.get(db) ?? {refs: new Set<WeakRef<Repo>>(), sweepAt: SWEEP_FLOOR}
  if (entry.refs.size >= entry.sweepAt) {
    for (const ref of entry.refs) if (ref.deref() === undefined) entry.refs.delete(ref)
    entry.sweepAt = Math.max(SWEEP_FLOOR, entry.refs.size * 2)
  }
  entry.refs.add(new WeakRef(repo))
  reposByDb.set(db, entry)
}

/** Unpin every Repo built over `db` and let its deferred work settle.
 *
 *  A pinned Repo is not idle: any `repo.tx` primes the property registry, which
 *  schedules a seed-materialization pass, which parks on a `workspace_members`
 *  row that most tests never insert — holding a subscription on a db that is
 *  about to close under it. Unpinning aborts that wait; a pass whose idle timer
 *  has not fired yet then refuses at the access gate without touching the db.
 *
 *  Best-effort per Repo, reporting afterwards: unpinning runs projector
 *  disposers synchronously, and one that throws would otherwise leave every
 *  Repo after it in the loop pinned — the exact state this exists to prevent,
 *  reached while reporting that it failed. */
export const releaseTestRepos = async (db: CreateTestRepoOptions['db']): Promise<void> => {
  const entry = reposByDb.get(db)
  if (!entry) return
  const live = [...entry.refs]
    .map(ref => ref.deref())
    .filter((repo): repo is Repo => repo !== undefined)
  entry.refs.clear()

  const failures: unknown[] = []
  for (const repo of live) {
    try {
      repo.setActiveWorkspaceId(null)
    } catch (error) {
      failures.push(error)
    }
  }
  for (const settled of await Promise.allSettled(live.map(repo => repo.awaitSeedMaterialization()))) {
    if (settled.status === 'rejected') failures.push(settled.reason)
  }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) {
    throw new AggregateError(failures, `[releaseTestRepos] ${failures.length} Repos failed to release`)
  }
}
