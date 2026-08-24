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
import type { User } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import {
  buildInteractionRecord,
  interactionMetricsUIStateType,
  interactionRecordProp,
  queryNameFromHandleKey,
  resetInteractionSessions,
  writeInteractionSample,
} from '../record'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetInteractionSessions()
  resetClientIdCache()
  repo = createTestRepo({
    db: sharedDb.db,
    user: USER,
    extensions: [definitionSeedsFacet.of(interactionRecordProp, { source: 'test' })],
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
  clientId: 'client-9', deviceLabel: 'installed:MacIntel', blockCount: 327_902,
}

describe('queryNameFromHandleKey', () => {
  it('keeps a bare name and strips the serialized args', () => {
    expect(queryNameFromHandleKey('core.recentActivity')).toBe('core.recentActivity')
    expect(queryNameFromHandleKey('groupedBacklinks.forBlock:[["string","blk-42"]]'))
      .toBe('groupedBacklinks.forBlock')
  })

  it('keeps a name that contains a colon, since the args boundary is `:[`', () => {
    expect(queryNameFromHandleKey('plugin:tasks/dueSoon:[["number",3]]')).toBe('plugin:tasks/dueSoon')
  })

  // The reason this function exists: args carry block ids and raw search text,
  // and the record is a synced block a human may paste into a public issue.
  it('drops argument content even when the argument itself contains the boundary', () => {
    const key = 'quickFind.search:[["string","a:[b secret"]]'
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
          topHeavy: [{ key: 'groupedBacklinks.forBlock:[["string","blk-private"]]', depCount: 4 }],
        },
      } as Partial<ReturnType<Repo['metrics']>>),
      META,
    )
    expect(record.handles.topHeavy).toEqual([{ query: 'groupedBacklinks.forBlock', depCount: 4 }])
    expect(JSON.stringify(record)).not.toContain('blk-private')
  })

  it('keeps the costliest queries and drops the tail', () => {
    const queries: Record<string, ReturnType<typeof timing>> = {}
    for (let i = 0; i < 20; i++) queries[`q${i}`] = timing({ totalMs: i })
    const record = buildInteractionRecord(metricsFixture({ queries } as Partial<ReturnType<Repo['metrics']>>), META)
    const kept = Object.keys(record.queries)
    expect(kept).toHaveLength(12)
    expect(kept).toContain('q19')
    expect(kept).not.toContain('q0')
  })
})

describe('writeInteractionSample', () => {
  const groupId = async (): Promise<string> => {
    const root = await getPluginUIStateBlock(repo, WS, USER, interactionMetricsUIStateType)
    return (await getPluginUIStateChild(root, getClientId())).id
  }
  const childIds = async (parent: string): Promise<string[]> =>
    (await sharedDb.db.getAll<{ id: string }>(
      'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0',
      [parent],
    )).map((r) => r.id)

  it('creates one record block under the client group and stores the sample', async () => {
    const blockId = await writeInteractionSample(repo, WS)
    expect(await childIds(await groupId())).toEqual([blockId])
    const block = repo.block(blockId)
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
})
