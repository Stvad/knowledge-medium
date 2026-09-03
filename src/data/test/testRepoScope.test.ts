// @vitest-environment node
/**
 * Pins the per-test Repo lifetime (#813). The property under test is
 * inherently cross-test — "a Repo built in one test is dead by the next" — so
 * the first two cases run in order and the second reads what the first left.
 * Vitest runs a file's tests sequentially in declaration order; nothing here
 * asks for a shuffled or isolated run.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BLOCKS_SYNCED_RAW_TABLE, blockToSyncedRowParams } from '@/data/blockSchema'
import type { Repo } from '@/data/repo'
import type { Materializability } from '@/sync/transform'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { beginTestRepoScope, endTestRepoScope } from '@/data/test/testRepoScope'

const WS = 'ws-1'

const observerOf = (repo: Repo): unknown =>
  (repo as unknown as {syncObserver: unknown}).syncObserver

let shared: TestDb
/** Built in `beforeAll`, i.e. before any scope opens — the deliberate carve-out. */
let fileLifetime: Repo
let builtInsideATest: Repo | null = null

beforeAll(async () => {
  shared = await createTestDb()
  fileLifetime = createTestRepo({db: shared.db}).repo
  fileLifetime.setActiveWorkspaceId(WS)
})
afterAll(async () => {
  // What the carve-out costs the file that takes it: a Repo the scope does not
  // release has to be released here, or its parked pass logs into the run when
  // the db closes under it.
  fileLifetime.setActiveWorkspaceId(null)
  await shared.cleanup()
})
beforeEach(async () => { await resetTestDb(shared.db) })

describe('per-test Repo scope', () => {
  it('leaves a Repo built inside a test fully live for that test', async () => {
    const {repo} = createTestRepo({db: shared.db, startSyncObserver: true})
    repo.setActiveWorkspaceId(WS)
    expect(observerOf(repo)).not.toBeNull()
    await repo.tx(
      tx => tx.create({id: 'seeded', workspaceId: WS, parentId: null, orderKey: 'a0'}),
      {scope: ChangeScope.BlockDefault},
    )
    expect(repo.activeWorkspaceId).toBe(WS)
    builtInsideATest = repo
  })

  it('releases it when that test ends, so it cannot write into the next one', () => {
    // Unpinning is the cancel gesture: it aborts the seed-materialization
    // generation, which rejects the parked `workspace_members` wait and drops
    // its subscription on the shared db. That link is pinned separately in
    // definitionSeeds.test.ts; what this asserts is that the scope performs it.
    expect(builtInsideATest, 'the previous test must have run').not.toBeNull()
    expect(builtInsideATest!.activeWorkspaceId).toBeNull()
    // Its `db.onChange` subscription is gone too. Read through a cast because
    // the field is private and there is no public "is it running": the
    // alternative — proving the observer does not materialize a synced row —
    // is an absence assertion on an async path, green either way on first pass.
    expect(observerOf(builtInsideATest!)).toBeNull()
  })

  it('leaves a Repo built in beforeAll pinned, because the whole file shares it', () => {
    expect(fileLifetime.activeWorkspaceId).toBe(WS)
  })

  it('does not close while a sync-observer drain is mid-window', async () => {
    // `dispose()` is synchronous and the drain only re-checks `disposed` at the
    // top of its loop, so a window already inside `applyWindow` commits whatever
    // the scope does — the question is only whether it commits BEFORE the next
    // test's `resetTestDb` or after it. Asserted as an ordering rather than a
    // timeout: the gate below cannot resolve on its own, so a scope that fails
    // to wait finishes with `drain` missing from the log entirely.
    const order: string[] = []
    let openGate = (): void => {}
    const gate = new Promise<void>(resolve => { openGate = resolve })
    let reachedGate = false

    const {repo} = createTestRepo({
      db: shared.db,
      startSyncObserver: true,
      syncObserverDeps: {
        getMaterializability: async (): Promise<Materializability> => {
          reachedGate = true
          await gate
          order.push('drain')
          return 'copy'
        },
        getCek: async () => null,
      },
    })
    repo.setActiveWorkspaceId(WS)

    await shared.db.execute(
      BLOCKS_SYNCED_RAW_TABLE.put.sql,
      blockToSyncedRowParams({
        id: 'staged', workspaceId: WS, parentId: null, orderKey: 'a0', content: 'v1',
        properties: {}, references: [], createdAt: 500, updatedAt: 900,
        userUpdatedAt: 900, createdBy: 'u', updatedBy: 'u', deleted: false,
      }),
    )
    void repo.flushSyncObserver()
    // Genuinely mid-window, not merely scheduled.
    await vi.waitFor(() => { expect(reachedGate).toBe(true) })

    const closing = endTestRepoScope().then(() => { order.push('scope-closed') })
    setTimeout(openGate, 0)
    await closing

    expect(order).toEqual(['drain', 'scope-closed'])
  })

  it('refuses to open a second scope over the first', () => {
    // A scope is open right now (this test is running inside one), so opening
    // another would strand every Repo already enrolled in it.
    expect(() => beginTestRepoScope()).toThrow(/already open/)
  })
})
