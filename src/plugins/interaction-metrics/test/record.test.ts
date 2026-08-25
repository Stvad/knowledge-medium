// @vitest-environment node
/**
 * The pure metrics→record fold (including the privacy boundary on handle keys)
 * and the create-once / update-in-place session write.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { getPluginUIStateBlock, getPluginUIStateChild } from '@/data/stateBlocks'
import { getClientId, resetClientIdCache } from '@/utils/clientId'
import { ChangeScope, type User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import {
  buildInteractionRecord,
  interactionMetricsUIStateType,
  interactionRecordProp,
  interactionRecordType,
  queryNameFromHandleKey,
  writeInteractionSample,
} from '../record'
import { resetMetricsSession } from '../sessionContext'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo


beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetMetricsSession()
  resetClientIdCache()
  repo = createTestRepo({
    db: sharedDb.db,
    user: USER,
    extensions: [
      definitionSeedsFacet.of(interactionRecordProp, { source: 'test' }),
      typeSeedsFacet.of(interactionRecordType, { source: 'test' }),
    ],
  }).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => { vi.restoreAllMocks() })

const timing = (over: Partial<{calls: number; p50Ms: number; p95Ms: number; totalMs: number}> = {}) => ({
  calls: 1, sampleCount: 1, meanMs: 1, p50Ms: 1, p95Ms: 1, p99Ms: 1, minMs: 1, maxMs: 1, totalMs: 1, ...over,
})

const metricsFixture = (over: Partial<ReturnType<Repo['metrics']>> = {}): ReturnType<Repo['metrics']> => ({
  handleStore: { invalidations: 10, handlesWalked: 200, loaderRuns: 12 },
  handleStoreInventory: {
    handleCount: 54, totalDeps: 900, maxDeps: 240, p50Deps: 3, p95Deps: 120, topHeavy: [],
  },
  blockCache: {},
  queries: {},
  db: { writeTransaction: timing({ calls: 7 }) },
  slowestTx: { description: 'append tag [[Private Page]]', ms: 91 },
  txLog: [{ description: 'rename property Secret', ms: 12 }],
  reprojection: {
    calls: 0, schemasReprojected: 0, rowsScanned: 0, blocksUpdated: 0, msTotal: 0,
    skippedByMarker: 0, skippedByAbsence: 0,
  },
  ...over,
} as ReturnType<Repo['metrics']>)

const META = {
  recordedAt: 5_000, startedAt: 1_000, appVersion: '2026.08.24', appSha: 'abc1234',
  clientId: 'client-9', deviceLabel: 'installed:MacIntel', blockCount: 327_902, ownWrites: 0,
}

describe('queryNameFromHandleKey', () => {
  // Production keys are `query:<name>@<registryEpoch>` plus serialized args --
  // the shape `Repo.dispatchQuery` builds, not a bare name.
  it('strips the query wrapper, the registry epoch and the args', () => {
    expect(queryNameFromHandleKey('query:core.recentActivity@2')).toBe('core.recentActivity')
    expect(queryNameFromHandleKey('query:groupedBacklinks.forBlock@7:[["string","blk-42"]]'))
      .toBe('groupedBacklinks.forBlock')
  })

  // A registry swap bumps the epoch. Leaving it in would file the same query
  // under a new name mid-session and break the grouping a trend depends on.
  it('groups the same query across registry epochs', () => {
    expect(queryNameFromHandleKey('query:core.children@2:[["string","b"]]'))
      .toBe(queryNameFromHandleKey('query:core.children@31:[["string","b"]]'))
  })

  it('keeps a name that contains a colon, since the args boundary is `:[`', () => {
    expect(queryNameFromHandleKey('query:plugin:tasks/dueSoon@1:[["number",3]]'))
      .toBe('plugin:tasks/dueSoon')
  })

  // The reason this function exists: args carry block ids and raw search text,
  // and the record is a synced block a human may paste into a public issue.
  it('drops argument content even when the argument itself contains the boundary', () => {
    const key = 'query:quickFind.search@1:[["string","a:[b secret"]]'
    expect(queryNameFromHandleKey(key)).toBe('quickFind.search')
    expect(queryNameFromHandleKey(key)).not.toContain('secret')
  })
})

describe('buildInteractionRecord', () => {
  it('folds counters into the record and derives the session window', () => {
    const record = buildInteractionRecord(metricsFixture(), META)
    expect(record).toMatchObject({
      recordedAt: 5_000,
      startedAt: 1_000,
      sessionMs: 4_000,
      blockCount: 327_902,
      appSha: 'abc1234',
      writes: 7,
      fanout: { invalidations: 10, handlesWalked: 200, loaderRuns: 12 },
      handles: { count: 54, maxDeps: 240, p95Deps: 120 },
    })
  })

  // Tx descriptions are interpolated with user content at ~30 call sites
  // (`append tag [[<name>]]`, `rename property <name>`), so the record must not
  // carry them at all -- there is no safe subset to keep.
  // A monitor must not measure its own bookkeeping: `writes` is the DENOMINATOR
  // of the fan-out ratio, so counting the recorder's own transactions deflates
  // it -- the direction that hides regressions rather than inventing them.
  it('discounts the recorder\'s own transactions from the write count', () => {
    const metrics = metricsFixture({ db: { writeTransaction: timing({ calls: 10 }) } } as Partial<ReturnType<Repo['metrics']>>)
    expect(buildInteractionRecord(metrics, META).writes).toBe(10)
    expect(buildInteractionRecord(metrics, { ...META, ownWrites: 4 }).writes).toBe(6)
  })

  it('stores no transaction descriptions', () => {
    const record = buildInteractionRecord(metricsFixture(), META)
    const serialized = JSON.stringify(record)
    expect(serialized).not.toContain('Private Page')
    expect(serialized).not.toContain('Secret')
  })

  it('reduces topHeavy handle keys to query names', () => {
    const record = buildInteractionRecord(
      metricsFixture({
        handleStoreInventory: {
          handleCount: 2, totalDeps: 5, maxDeps: 4, p50Deps: 1, p95Deps: 4,
          topHeavy: [{ key: 'query:groupedBacklinks.forBlock@3:[["string","blk-private"]]', depCount: 4 }],
        },
      } as Partial<ReturnType<Repo['metrics']>>),
      META,
    )
    expect(record.handles.topHeavy).toEqual([{ query: 'groupedBacklinks.forBlock', depCount: 4 }])
    expect(JSON.stringify(record)).not.toContain('blk-private')
  })

  // Ranking by cost and truncating would hide the transition most worth
  // catching: a cheap query has no stored baseline, so when it becomes
  // expensive the comparison meets a name it has never seen and reads it as a
  // newly mounted surface rather than a regression.
  it('keeps every measured query, including the cheap ones', () => {
    const queries: Record<string, ReturnType<typeof timing>> = {}
    for (let i = 0; i < 20; i++) queries[`q${i}`] = timing({ totalMs: i })
    const record = buildInteractionRecord(metricsFixture({ queries } as Partial<ReturnType<Repo['metrics']>>), META)
    expect(Object.keys(record.queries)).toHaveLength(20)
    expect(record.queries.q0).toBeDefined()
  })

  it('bounds the stored set so a pathological session cannot grow the record', () => {
    const queries: Record<string, ReturnType<typeof timing>> = {}
    for (let i = 0; i < 200; i++) queries[`q${i}`] = timing({ totalMs: i })
    const record = buildInteractionRecord(metricsFixture({ queries } as Partial<ReturnType<Repo['metrics']>>), META)
    expect(Object.keys(record.queries)).toHaveLength(64)
    expect(record.queries.q199).toBeDefined()
  })
})

describe('writeInteractionSample', () => {
  const groupId = async (): Promise<string> => {
    const root = await getPluginUIStateBlock(repo, WS, USER, interactionMetricsUIStateType)
    return (await getPluginUIStateChild(root, getClientId())).id
  }
  const stored = async (blockId: string) => {
    const block = repo.block(blockId)
    await block.load()
    return block.peekProperty(interactionRecordProp)
  }
  const childIds = async (parent: string): Promise<string[]> =>
    (await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0',
      [parent],
    )).map((r) => r.id)

  it('creates one record block under the client group and stores the sample', async () => {
    const blockId = await writeInteractionSample(repo, WS)
    expect(blockId).not.toBeNull()
    expect(await childIds(await groupId())).toEqual([blockId])
    const block = repo.block(blockId!)
    await block.load()
    expect(block.peekProperty(interactionRecordProp)).toMatchObject({
      clientId: getClientId(),
      writes: expect.any(Number),
    })
  })

  // The session's record is a single point in the series, refined as the
  // session goes on -- not an append log.
  it('updates the same block on later samples instead of appending', async () => {
    const first = await writeInteractionSample(repo, WS)
    const second = await writeInteractionSample(repo, WS)
    expect(second).toBe(first)
    expect(await childIds(await groupId())).toHaveLength(1)
  })

  // Automation scope is admitted locally in a read-only workspace and then
  // refused by the server's RLS, parking the write in the rejection quarantine
  // that the status chip reports to the user. A recurring sampler would keep
  // manufacturing those.
  it('writes nothing in a read-only workspace', async () => {
    repo.setReadOnly(true)
    const tx = vi.spyOn(repo, 'tx')
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    expect(tx).not.toHaveBeenCalled()
  })

  // repo.metrics() counters are page-global, not per workspace, so a second
  // workspace would inherit the first's queries and writes while reporting its
  // own block count.
  it('stops sampling once a page session has seen a second workspace', async () => {
    const first = await writeInteractionSample(repo, WS)
    expect(first).not.toBeNull()
    expect(await writeInteractionSample(repo, 'ws-2')).toBeNull()
    // And does not resume on switching back -- the counters stay blended.
    expect(await writeInteractionSample(repo, WS)).toBeNull()
  })

  // Writing a property to a tombstone does not restore it, so without this the
  // session would keep updating a row no reader can see.
  it('opens a replacement record when the current one is deleted', async () => {
    const first = await writeInteractionSample(repo, WS)
    await repo.tx(async (tx) => { await tx.delete(first!) }, { scope: ChangeScope.Automation })
    const second = await writeInteractionSample(repo, WS)
    expect(second).not.toBe(first)
    expect(await childIds(await groupId())).toContain(second)
  })

  // These blocks are deliberately inspectable, so the group can hold a
  // hand-created child. Telemetry retention must never be able to reach
  // anything a person wrote — including by counting it toward the offset.
  it('never prunes a block that carries no record', async () => {
    const blockId = (await writeInteractionSample(repo, WS))!
    const parent = (await sharedDb.db.getAll<{ parent_id: string }>(
      'SELECT parent_id FROM blocks WHERE id = ?', [blockId],
    ))[0].parent_id
    await repo.tx(async (tx) => {
      await tx.create({ id: 'hand-written', workspaceId: WS, parentId: parent, orderKey: 'a0',
        content: 'a note someone made here', properties: {} }, { systemMint: true })
    }, { scope: ChangeScope.Automation })

    resetMetricsSession()
    await writeInteractionSample(repo, WS)

    const survivor = await sharedDb.db.getOptional<{ deleted: number }>(
      'SELECT deleted FROM blocks WHERE id = ?', ['hand-written'],
    )
    expect(survivor?.deleted).toBe(0)
  })

  // blockCount is the dominant confound for every timing in the record, so a
  // session that grows the graph must not report its final timings against the
  // size the graph had when it opened.
  it('re-counts the graph on each sample', async () => {
    const first = await writeInteractionSample(repo, WS)
    const before = (await stored(first!))!.blockCount
    await repo.tx(async (tx) => {
      for (let i = 0; i < 3; i++) {
        await tx.create({ id: `extra-${i}`, workspaceId: WS, parentId: null, orderKey: `a${i}`,
          content: 'x', properties: {} }, { systemMint: true })
      }
    }, { scope: ChangeScope.Automation })
    await writeInteractionSample(repo, WS)
    // At least the three: the sample also sees the ui-state blocks its own
    // first write created, which the opening count was taken before.
    expect((await stored(first!))!.blockCount).toBeGreaterThanOrEqual(before + 3)
  })
})
