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
        // A backfill marker's payload is its PRESENCE; the table's `value`
        // column belongs to the rows that carry one and must stay NULL here.
        // Binding it threw on every call once, unnoticed, because the runner
        // recorded its outcome BEFORE this ran — so a completion that always
        // failed still reported success.
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
  return { repo, cache }
}
