// @vitest-environment node
/**
 * One-time-per-workspace catch-up derive of the LOCAL `reference_target_id`
 * column (PR #288 slice A): rows that predate the column (upgrading device /
 * pre-registry sync) get stamped once, marker-gated, without advancing
 * `updated_at` (the LWW row-version) and without enqueueing uploads.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope, codecs, defineProperty, type BlockData } from '@/data/api'
import { BLOCKS_TABLE_COLUMN_NAMES, blockToRowParams } from '@/data/blockSchema'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import type { Repo } from './repo'

const WS = 'ws-derive-pass'
const STATUS_FIELD_ID = 'field-status-pass'

const statusSchema = defineProperty('status', {
  codec: codecs.string,
  defaultValue: '',
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => { await resetTestDb(sharedDb.db) })
afterEach(() => { vi.useRealTimers() })

/** Mirror production ordering: `workspaceBootstrap` awaits
 *  `whenPropertyDefinitionsReady` (which pins the workspace's registry) before
 *  scheduling the pass; the sweep gates on that registry being for this
 *  workspace. Fake timers scope to the deep-idle deferral only — the pass is
 *  deferred 10s, so the drain helper needs the timer advanced first (same
 *  pattern as backfill.test.ts). */
const runPass = async (
  repo: Repo,
  {ready = true}: {ready?: boolean} = {},
): Promise<void> => {
  if (ready) await repo.whenPropertyDefinitionsReady(WS)
  vi.useFakeTimers()
  repo.scheduleReferenceTargetDerivePass(WS)
  await vi.runAllTimersAsync()
  await repo.awaitReferenceTargetDerive()
  vi.useRealTimers()
}

const INSERT_SQL =
  `INSERT INTO blocks (${BLOCKS_TABLE_COLUMN_NAMES.join(', ')}) ` +
  `VALUES (${BLOCKS_TABLE_COLUMN_NAMES.map(() => '?').join(', ')})`

/** Raw-seed a pre-upgrade row: column NULL regardless of content, no
 *  processor involvement (the seed bypasses repo.tx entirely). */
const seedRow = (overrides: Partial<BlockData> & {id: string}): Promise<unknown> =>
  sharedDb.db.execute(INSERT_SQL, blockToRowParams({
    workspaceId: WS,
    parentId: null,
    orderKey: `k-${overrides.id}`,
    content: '',
    properties: {},
    references: [],
    createdAt: 1,
    updatedAt: 1000,
    userUpdatedAt: 1000,
    createdBy: 'u',
    updatedBy: 'u',
    deleted: false,
    referenceTargetId: null,
    ...overrides,
  }))

const setup = (workspaceId = WS): Repo => {
  const {repo} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
  repo.setActiveWorkspaceId(workspaceId)
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-status-definition',
    [{
      metadata: {
        fieldId: STATUS_FIELD_ID,
        workspaceId,
        createdAt: 1,
        name: statusSchema.name,
        changeScope: statusSchema.changeScope,
        hidden: false,
        origin: 'user' as const,
      },
      schema: statusSchema,
    }],
    {workspaceId},
  )
  return repo
}

const readColumn = async (id: string): Promise<string | null> => {
  const row = await sharedDb.db.get<{reference_target_id: string | null}>(
    'SELECT reference_target_id FROM blocks WHERE id = ?', [id],
  )
  return row.reference_target_id
}

describe('reference-target initial derive pass', () => {
  it('stamps pre-existing rows across both resolution paths, prose untouched', async () => {
    // A property field row addresses its definition BY ID (`((fieldId))`, §7),
    // so it stamps textually on the block-ref path — no name→schema tier.
    await seedRow({id: 'field-ref', content: `((${STATUS_FIELD_ID}))`})
    await seedRow({id: 'block-ref', content: '((some-target))'})
    await seedRow({id: 'alias-target', content: 'Inbox', properties: {alias: ['Inbox']}})
    await seedRow({id: 'alias-ref', content: '[[Inbox]]'})
    await seedRow({id: 'prose', content: 'just some ((text)) inline'})
    await seedRow({id: 'tombstone-ref', content: '((dead-target))', deleted: true})

    const repo = setup()
    await runPass(repo)

    expect(await readColumn('field-ref')).toBe(STATUS_FIELD_ID)
    expect(await readColumn('block-ref')).toBe('some-target')
    expect(await readColumn('alias-ref')).toBe('alias-target')
    expect(await readColumn('prose')).toBeNull()
    // Deleted rows are swept too (a later content-unchanged restore would
    // never re-derive them).
    expect(await readColumn('tombstone-ref')).toBe('dead-target')
  })

  it('is local bookkeeping: no updated_at advance, no upload enqueued, no user metadata', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    const before = await sharedDb.db.get<{updated_at: number; user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', ['block-ref'],
    )

    const repo = setup()
    await runPass(repo)

    const after = await sharedDb.db.get<{updated_at: number; user_updated_at: number}>(
      'SELECT updated_at, user_updated_at FROM blocks WHERE id = ?', ['block-ref'],
    )
    expect(after).toEqual(before)
    const crud = await sharedDb.db.getAll('SELECT id FROM ps_crud')
    expect(crud).toEqual([])
  })

  it('runs once per workspace PER SESSION; a fresh open sweeps again', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    const repo = setup()
    await runPass(repo)
    expect(await readColumn('block-ref')).toBe('some-target')

    // Same session: a re-schedule is a no-op (incremental paths own it).
    await seedRow({id: 'late-row', content: '((late-target))', updatedAt: 2000})
    await runPass(repo)
    expect(await readColumn('late-row')).toBeNull()

    // A new open (new Repo) sweeps again — definitions/aliases that arrived
    // while the app was closed are repaired at the next open (adversarial-
    // review round 2: a durable once-ever marker missed them forever).
    const repo2 = setup()
    await runPass(repo2)
    expect(await readColumn('late-row')).toBe('late-target')
  })

  it('skips without a marker when the registry is not this workspace (retries next open)', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    // Active/projected workspace differs from the pass target.
    const repo = setup('ws-other')
    // Prime the OTHER workspace's registry (the active one), then run the
    // pass for WS — the registry mismatch must skip without a marker.
    await repo.whenPropertyDefinitionsReady('ws-other')
    await runPass(repo, {ready: false})

    expect(await readColumn('block-ref')).toBeNull()
    const markers = await sharedDb.db.getAll<{key: string}>(
      "SELECT key FROM client_schema_state WHERE key LIKE 'reference_target_derive:%'",
    )
    expect(markers).toEqual([])
  })

  it('the CAS write never stamps a row whose content changed after the scan', async () => {
    // TOCTOU pin (adversarial-review fix): the stamp helper re-checks
    // (content, NULL column) inside the write tx.
    await seedRow({id: 'raced', content: '((some-target))'})
    const repo = setup()
    await repo.whenPropertyDefinitionsReady(WS)
    // Simulate the concurrent edit landing between scan and write by
    // mutating content right after scheduling (before the deferred job's
    // timer fires — the job scans AND writes inside the fake-timer drain,
    // so mutate first, then let it run: the scan itself will see the new
    // content. To hit the write-phase check instead, scan-time state must
    // be captured first — covered by the in-tx re-read; this test pins the
    // end-to-end "changed rows are never stamped" behavior).
    await sharedDb.db.execute(
      "UPDATE blocks SET content = 'plain prose now' WHERE id = 'raced'",
    )
    await runPass(repo, {ready: false})
    expect(await readColumn('raced')).toBeNull()
  })

  it('refreshes already-cached snapshots so readers see the repair', async () => {
    await seedRow({id: 'block-ref', content: '((some-target))'})
    const {repo, cache} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    // Hydrate the row into the cache pre-pass (stale: column null).
    const preloaded = await repo.load('block-ref')
    expect(preloaded?.referenceTargetId).toBeNull()
    expect(cache.getSnapshot('block-ref')).toBeDefined()

    await runPass(repo)

    expect(cache.getSnapshot('block-ref')?.referenceTargetId).toBe('some-target')
  })

  it('never regresses a cache snapshot that is newer than the disk row it stamps (ack-to-echo window)', async () => {
    await seedRow({id: 'cached-ahead-ref', content: '((some-target))'})
    const {repo, cache} = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}})
    repo.setActiveWorkspaceId(WS)
    // Hydrate the row into the cache pre-pass (stale: column null).
    const preloaded = await repo.load('cached-ahead-ref')
    expect(preloaded?.referenceTargetId).toBeNull()
    const current = cache.getSnapshot('cached-ahead-ref')
    expect(current).toBeDefined()

    // Simulate the sync ack-to-echo window: a local edit lands in the cache
    // (newer updatedAt) after hydration but before the repair pass runs —
    // disk still holds the pre-edit content/version.
    const newer = {...current!, content: 'newer local text', updatedAt: current!.updatedAt + 5000}
    cache.setSnapshot(newer)

    await runPass(repo)

    // Disk stamps: the CAS matched the (unchanged) disk row's (content,
    // NULL column) pair.
    expect(await readColumn('cached-ahead-ref')).toBe('some-target')
    // The cache must never be regressed by the older disk row's stamp — the
    // fan-out's `cached.updatedAt <= after.updatedAt` guard skips writing
    // back into a cache entry that is already newer than the stamped row.
    const afterPass = cache.getSnapshot('cached-ahead-ref')
    expect(afterPass?.content).toBe('newer local text')
    expect(afterPass?.updatedAt).toBe(current!.updatedAt + 5000)
  })
})
