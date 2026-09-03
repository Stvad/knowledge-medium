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
import { observeWorkspace, pageRecordStartedAt, resetMetricsSession, setPageRecord } from '../sessionContext'
import { INTERACTION_RETAIN } from '../record'

const WS = 'ws-1'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo


beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
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
  // The user's share: fewer invalidations than the page total, because the
  // recorder's own creates are counted on the other side of the line.
  excludingTelemetry: { writes: 6, handleStore: { invalidations: 4, loaderRuns: 12 } },
  epoch: 0,
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
      writes: 6,
      fanout: { invalidations: 4, loaderRuns: 12 },
      handles: { count: 54, maxDeps: 240, p95Deps: 120 },
    })
  })

  // Tx descriptions are interpolated with user content at ~30 call sites
  // (`append tag [[<name>]]`, `rename property <name>`), so the record must not
  // carry them at all -- there is no safe subset to keep.
  // A monitor must not report its own bookkeeping as load. The recorder does
  // not subtract anything: the Repo counts its transactions on the other side
  // of the telemetry line, in the same synchronous block as the invalidation
  // walk they cause, and the record reads that pair.
  it('reports the counters that exclude the recorder\'s own work', () => {
    const record = buildInteractionRecord(metricsFixture(), META)
    expect(record.writes).toBe(6)
    expect(record.fanout).toEqual({ invalidations: 4, loaderRuns: 12 })
    // Not the page totals, which include our own writes.
    expect(record.fanout.invalidations).not.toBe(10)
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
  })

  // Past the bound, WHICH names survive must not depend on what is being
  // measured. Selecting the top N by cost means a query that was cheap is
  // absent from the baseline, so the session where it turns expensive compares
  // against no history at all — a regression reported as a new surface. Two
  // sessions measuring the same names must therefore store the same names,
  // whatever their timings did in between.
  it('stores the same query names whatever the timings did', () => {
    const names = Array.from({ length: 200 }, (_, i) => `q${i}`)
    const recordFor = (cost: (i: number) => number): string[] => {
      const queries: Record<string, ReturnType<typeof timing>> = {}
      names.forEach((n, i) => { queries[n] = timing({ totalMs: cost(i) }) })
      return Object.keys(
        buildInteractionRecord(metricsFixture({ queries } as Partial<ReturnType<Repo['metrics']>>), META).queries,
      ).sort()
    }
    expect(recordFor((i) => i)).toEqual(recordFor((i) => 200 - i))
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

  /** Flip state in the window between the pre-checks and the write: run
   *  `lapse` as the record transaction is entered, so the in-transaction
   *  re-check is the only thing that can still refuse. (Patching `repo.db`
   *  instead recurses through the timing proxy and blows the stack.) */
  const lapseBeforeWrite = (lapse: () => void): void => {
    const realTx = repo.tx.bind(repo)
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description === 'interaction metrics record') lapse()
      return realTx(fn, opts)
    })
  }

  /** Flip state INSIDE the transaction, after each in-transaction read yields.
   *  That is the window an eligibility check placed before those reads cannot
   *  see: the reads are awaits, so anything synchronous can land between the
   *  check and the write it was supposed to authorise. */
  const lapseAfterTxRead = (lapse: () => void): void => {
    const realTx = repo.tx.bind(repo)
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) =>
      realTx(async (tx) => {
        const realGet = tx.get.bind(tx)
        tx.get = async (id: string) => {
          const row = await realGet(id)
          if (opts?.description === 'interaction metrics record') lapse()
          return row
        }
        return fn(tx)
      }, opts))
  }

  // The pre-checks run before several awaits — including a membership wait of
  // up to ten seconds — so eligibility can lapse before the write. Both of
  // these were unpinned, which is how a refactor silently weakened one.
  it('refuses when the workspace stops being attributable mid-write', async () => {
    lapseBeforeWrite(() => observeWorkspace(repo, 'ws-2'))
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    expect(await childIds(await groupId())).toEqual([])
  })

  it('refuses when the workspace turns read-only mid-write', async () => {
    lapseBeforeWrite(() => repo.setReadOnly(true))
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    expect(await childIds(await groupId())).toEqual([])
  })

  // The transaction's own reads are awaits, so a check placed before them is a
  // check on a state that can have moved by the time anything is written. These
  // pin the ORDER, not the presence, of the in-transaction checks: with the
  // check first, the reset lands after it and the stale payload is written.
  it('refuses a reset that lands after the create path reads', async () => {
    lapseAfterTxRead(() => repo.resetMetrics())
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    expect(await childIds(await groupId())).toEqual([])
  })

  it('refuses a reset that lands after the update path reads', async () => {
    const first = await writeInteractionSample(repo, WS)
    expect(first).toBeTruthy()

    lapseAfterTxRead(() => repo.resetMetrics())
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    // The record this session already owns is untouched, not half-rewritten.
    expect(await childIds(await groupId())).toEqual([first])
  })

  // A reset starts a new counter span. The attribution check ADOPTS it, so
  // without the epoch check the write is approved on the new span's terms while
  // the payload still holds the old span's counters — and the claim then points
  // the session at that stale row, so the next sample updates it rather than
  // opening a replacement.
  it('refuses when the counters are reset mid-write', async () => {
    lapseBeforeWrite(() => repo.resetMetrics())
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    expect(await childIds(await groupId())).toEqual([])
  })

  // These blocks are deliberately inspectable, so the group can hold a
  // hand-created child. Telemetry retention must never be able to reach
  // anything a person wrote — including by counting it toward the offset.
  //
  // The retention pass only deletes PAST its offset, so the group has to be
  // driven past it: with a handful of rows the deletion branch never runs and
  // the predicate under test is unreachable.
  it('never prunes a block that carries no record', async () => {
    const first = (await writeInteractionSample(repo, WS))!
    const parent = (await sharedDb.db.getAll<{ parent_id: string }>(
      'SELECT parent_id FROM blocks WHERE id = ?', [first],
    ))[0].parent_id

    const insert = async (id: string, orderKey: string, telemetry: boolean): Promise<void> => {
      await sharedDb.db.execute(
        `INSERT INTO blocks
           (id, workspace_id, parent_id, order_key, content, properties_json, deleted,
            created_at, updated_at, created_by, updated_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, 1, 1, ?, ?)`,
        [id, WS, parent, orderKey, telemetry ? '' : 'a note someone made here',
         telemetry
           ? JSON.stringify({ 'interaction-metrics:record': { recordedAt: 1, writes: 0, blockCount: 0, queries: {}, fanout: {} } })
           : '{}',
         USER.id, USER.id],
      )
    }
    // Enough telemetry rows to push anything after them past the retention
    // offset, then the hand-written block LAST so it is squarely in the range
    // an unfiltered pass would delete.
    for (let i = 0; i <= INTERACTION_RETAIN; i++) await insert(`rec-${i}`, `a${String(i).padStart(4, '0')}`, true)
    await insert('hand-written', 'z999', false)

    resetMetricsSession(repo)
    await writeInteractionSample(repo, WS)

    const survivor = await sharedDb.db.getOptional<{ deleted: number }>(
      'SELECT deleted FROM blocks WHERE id = ?', ['hand-written'],
    )
    expect(survivor?.deleted).toBe(0)
    // Precondition: the pass really did run and delete telemetry rows, so a
    // green result cannot mean "the deletion branch was never reached".
    const remaining = await sharedDb.db.getAll<{ n: number }>(
      "SELECT count(*) AS n FROM blocks WHERE parent_id = ? AND deleted = 1", [parent],
    )
    expect(remaining[0].n).toBeGreaterThan(0)
  })

  // `resetMetrics()` is a supported hook for measuring a discrete operation. It
  // zeroes the totals this session's accounting is relative to, so continuing
  // would subtract pre-reset writes from post-reset counters.
  it('starts a new record when the Repo counters are reset', async () => {
    const first = (await writeInteractionSample(repo, WS))!
    repo.resetMetrics()
    const second = await writeInteractionSample(repo, WS)
    expect(second).not.toBe(first)
    const stored = repo.block(second!)
    await stored.load()
    expect(stored.peekProperty(interactionRecordProp)!.writes).toBeGreaterThanOrEqual(0)
  })

  // The premise the whole telemetry flag rests on: a record create is a
  // live-set membership change, so it fires `kernel.content` and really does
  // invalidate a mounted workspace-wide handle. If that stops being true the
  // flag is dead weight, and this is the test that says so.
  it('keeps its own invalidations out of the sample it writes', async () => {
    const handle = repo.query.recentBlocks({ workspaceId: WS })
    handle.subscribe(() => {})
    await handle.load()

    // First sample: proves the premise. It really does invalidate the mounted
    // handle — which is why its transactions must not be counted as load.
    const totalBefore = repo.handleStore.metrics.loaderInvalidations
    await writeInteractionSample(repo, WS)
    expect(repo.handleStore.metrics.loaderInvalidations).toBeGreaterThan(totalBefore)

    // A later sample updates in place, and every transaction it issues is
    // flagged — so it moves the page totals and adds NOTHING to the figures a
    // reader compares. (The first sample is not zero on the user's side: the
    // shared ui-state helpers mint the container through the ordinary write
    // path, once per client group. Counting those as the user's work makes the
    // denominator bigger, which suppresses a finding rather than inventing one.)
    const before = repo.metrics()
    await writeInteractionSample(repo, WS)
    const after = repo.metrics()

    expect(after.excludingTelemetry.writes).toBe(before.excludingTelemetry.writes)
    expect(after.excludingTelemetry.handleStore).toEqual(before.excludingTelemetry.handleStore)
  })

  // The placement check runs before the block count, so a sync-applied or hand
  // edit can move the record out of the group before the update lands. Writing
  // then puts this session where `loadRecords` cannot find it — the sample is
  // lost either way, but silently rather than as a refusal the next sample
  // recovers from.
  it('refuses to update a record moved out of the group mid-write', async () => {
    const first = (await writeInteractionSample(repo, WS))!
    await repo.tx(async (tx) => {
      await tx.create({ id: 'elsewhere', workspaceId: WS, parentId: null, orderKey: 'a0',
        content: 'a page', properties: {} }, { systemMint: true })
    }, { scope: ChangeScope.Automation })

    const realTx = repo.tx.bind(repo)
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description === 'interaction metrics record') {
        await sharedDb.db.execute(
          'UPDATE blocks SET parent_id = ? WHERE id = ?', ['elsewhere', first])
      }
      return realTx(fn, opts)
    })
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    vi.restoreAllMocks()

    // Untouched where it now lives, and the next sample opens a replacement.
    const moved = await sharedDb.db.getOptional<{ parent_id: string }>(
      'SELECT parent_id FROM blocks WHERE id = ?', [first])
    expect(moved?.parent_id).toBe('elsewhere')
    const second = await writeInteractionSample(repo, WS)
    expect(second).not.toBe(first)
  })

  // Retention treats a row whose record was stripped as user content and refuses
  // to touch it. The recorder has to agree, or the next sample writes telemetry
  // back onto a block someone just repurposed and retention then declines to
  // clean up what the recorder restored.
  //
  // The two checks are tested SEPARATELY because each masks the other: with the
  // preflight blind, the in-transaction re-take still refuses (returning null),
  // and with the re-take blind the preflight still opens a replacement — so a
  // test that only asserts "not the same id" passes with either one deleted.
  it('opens a replacement when the current record was stripped before the sample', async () => {
    const first = (await writeInteractionSample(repo, WS))!
    await sharedDb.db.execute(
      'UPDATE blocks SET properties_json = ?, content = ? WHERE id = ?',
      ['{}', 'a note someone made here', first])

    // A REPLACEMENT, not a refusal — that is what only the preflight can do.
    const second = await writeInteractionSample(repo, WS)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)

    const repurposed = await sharedDb.db.getOptional<{ properties_json: string; content: string }>(
      'SELECT properties_json, content FROM blocks WHERE id = ?', [first])
    expect(repurposed?.properties_json).toBe('{}')
    expect(repurposed?.content).toBe('a note someone made here')
  })

  // Cleared through the codec rather than by hand: `optionalIdentity` encodes
  // `undefined` as `null`, so the key stays present and a strict check reads the
  // row as still ours.
  it('opens a replacement when the current record was cleared to null', async () => {
    const first = (await writeInteractionSample(repo, WS))!
    await sharedDb.db.execute(
      'UPDATE blocks SET properties_json = ? WHERE id = ?',
      [JSON.stringify({ [interactionRecordProp.name]: null }), first])

    const second = await writeInteractionSample(repo, WS)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  // Stripped in the window between the preflight and the write, so only the
  // in-transaction re-take can still refuse.
  it('refuses when the current record is stripped mid-write', async () => {
    const first = (await writeInteractionSample(repo, WS))!
    const realTx = repo.tx.bind(repo)
    vi.spyOn(repo, 'tx').mockImplementation(async (fn, opts) => {
      if (opts?.description === 'interaction metrics record') {
        await sharedDb.db.execute(
          'UPDATE blocks SET properties_json = ? WHERE id = ?', ['{}', first])
      }
      return realTx(fn, opts)
    })
    expect(await writeInteractionSample(repo, WS)).toBeNull()
    vi.restoreAllMocks()

    const repurposed = await sharedDb.db.getOptional<{ properties_json: string }>(
      'SELECT properties_json FROM blocks WHERE id = ?', [first])
    expect(repurposed?.properties_json).toBe('{}')
  })

  // `resetMetrics()` zeroes the counters the current record describes, so that
  // row covers a span the figures no longer cover. Detected by comparing the
  // epoch the Repo stamps, not by watching a counter step backwards — which is
  // undetectable once other writes have carried it back up, and which mis-fires
  // the other way into forking a second record block into the graph.
  it('opens a new record when the metrics epoch moves', async () => {
    const first = await writeInteractionSample(repo, WS)
    repo.resetMetrics()
    expect(await writeInteractionSample(repo, WS)).not.toBe(first)
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

/**
 * A committed record belongs to the span it was MEASURED in.
 *
 * `resetMetrics()` can land between the transaction's epoch check and the
 * commit callback. Claiming into the new span would give it a row whose
 * counters and `startedAt` describe the old one, and the next sample updates
 * that row in place — fresh counters against an inflated session duration.
 */
describe('claiming a committed record', () => {
  const spanRepo = (epoch: number) => ({ metrics: () => ({ epoch, epochWorkspaceId: WS }) })

  it('claims a record written under the current span', () => {
    const repoStub = spanRepo(1)
    resetMetricsSession(repoStub)

    setPageRecord(repoStub, WS, 'block-1', 5_000, 1)

    expect(pageRecordStartedAt(repoStub, WS)).toBe(5_000)
  })

  it('declines a record whose span was retired before it committed', () => {
    const repoStub = { epoch: 1, metrics() { return { epoch: this.epoch, epochWorkspaceId: WS } } }
    resetMetricsSession(repoStub)
    // The precondition, asserted rather than assumed: this claim WOULD land.
    setPageRecord(repoStub, WS, 'block-1', 5_000, 1)
    expect(pageRecordStartedAt(repoStub, WS)).toBe(5_000)
    resetMetricsSession(repoStub)

    // `resetMetrics()` between the sample's epoch check and its commit.
    repoStub.epoch = 2
    setPageRecord(repoStub, WS, 'block-1', 5_000, 1)

    expect(pageRecordStartedAt(repoStub, WS)).toBeNull()
  })
})

