// @vitest-environment node
/**
 * The analysis pass, where the live snapshot meets the stored series. Both
 * things pinned here are silent when wrong: a comparison against blended
 * counters invents regressions, and identifying "this session's record" by
 * position discards a real one.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope, type User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import {
  interactionRecordProp,
  interactionRecordType,
  writeInteractionSample,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record'
import { resetMetricsSession } from '@/plugins/interaction-metrics/sessionContext'
import { runPerfAnalysis } from '../analyze'
import { runPerfAnalysisNow } from '../schedule'
import { getPerfAnalysisFor, resetPerfAnalysisStore } from '../store'
import { isUsableInteractionRecord, loadRecords } from '../load'
import { interactionMetricsUIStateType } from '@/plugins/interaction-metrics/record'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo


beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
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

/** Each call stands in for a separate past page session. */
/** Stamp a record with values a comparison can actually use. The reported
 *  baseline is now the count of sessions the comparison CONSUMED, so a test
 *  asserting on it has to seed history that gets judged. */
const stamp = async (id: string, over: Partial<InteractionRecordData>): Promise<void> => {
  const block = repo.block(id)
  await block.load()
  const base = block.peekProperty(interactionRecordProp)!
  await repo.tx(async (tx) => {
    await tx.setProperty(id, interactionRecordProp, { ...base, ...over })
  }, { scope: ChangeScope.Automation })
}

const USABLE = { writes: 100, fanout: { loaderInvalidations: 10 } }

const pastSession = async (over?: Partial<InteractionRecordData>): Promise<string> => {
  resetMetricsSession(repo)
  const id = (await writeInteractionSample(repo, WS))!
  if (over) {
    const block = repo.block(id)
    await block.load()
    const base = block.peekProperty(interactionRecordProp)!
    await repo.tx(async (tx) => {
      await tx.setProperty(id, interactionRecordProp, { ...base, ...over })
    }, { scope: ChangeScope.Automation })
  }
  return id
}

/**
 * History in which the fan-out comparison genuinely fires, whatever the live
 * counters happen to be: a long cheap baseline, and a recent window already
 * expensive enough to carry the smoothed median on its own.
 *
 * Without this the guard under test is unpinnable — with a short or flat
 * history no comparison runs at all, so removing the guard changes nothing and
 * the test passes for the wrong reason.
 */
const seedFiringHistory = async (): Promise<void> => {
  // Stamped far in the future so these sort above any real record an earlier
  // step in the test left behind: the recent window is the first two entries,
  // and a stray record carrying no writes is (correctly) not usable history —
  // which would leave the live sample standing alone and report insufficient.
  for (let i = 0; i < 8; i++) {
    await pastSession({ recordedAt: 3e12 + i, writes: 100, fanout: { loaderInvalidations: 10 } })
  }
  for (let i = 0; i < 2; i++) {
    await pastSession({ recordedAt: 4e12 + i, writes: 10, fanout: { loaderInvalidations: 100 } })
  }
}

describe('runPerfAnalysis', () => {
  // A session that wrote nothing is a valid, loadable record that no rate can
  // be computed from — the comparison drops it before the median. Reporting the
  // rows LOADED tells a reader the verdict rests on history it never used,
  // which is the false confidence this feature exists to prevent.
  it('counts the sessions the comparison used, not the rows it loaded', async () => {
    await seedFiringHistory()
    // Loadable and valid, but carrying no rate: filtered out by the comparison.
    for (let i = 0; i < 4; i++) {
      await pastSession({ recordedAt: 2e12 + i, writes: 0, fanout: {} })
    }
    resetMetricsSession(repo)

    const analysis = await runPerfAnalysis(repo, WS, 1000)
    const loaded = await loadRecords<InteractionRecordData>(
      repo, WS, interactionMetricsUIStateType.id, interactionRecordProp.name,
      isUsableInteractionRecord)

    expect(loaded.length).toBeGreaterThanOrEqual(14)
    expect(analysis.baseline.interaction).toBeGreaterThan(0)
    expect(analysis.baseline.interaction).toBeLessThan(loaded.length)
  })

  // The workspace can change while the history reads are in flight, and the
  // analysis draws on AMBIENT state — `repo.isReadOnly` describes whichever
  // workspace is active now. Publishing would attach the new workspace's
  // recording blocker to the old one's verdict.
  it('does not publish a verdict for a workspace that is no longer active', async () => {
    resetPerfAnalysisStore()
    await pastSession()
    const analysis = await runPerfAnalysisNow(repo, WS)
    expect(getPerfAnalysisFor(WS)).toBe(analysis)

    resetPerfAnalysisStore()
    repo.setActiveWorkspaceId(OTHER_WS)
    await runPerfAnalysisNow(repo, WS)
    expect(getPerfAnalysisFor(WS)).toBeNull()
  })

  // repo.metrics() is page-global. The recorder stops sampling once a session
  // has seen two workspaces; the reader holds the same blended snapshot and
  // does not inherit that rule by the recorder having one.
  // The positive control for the test below: with this history the fan-out
  // comparison DOES fire, so the suppression it asserts is a real difference.
  // The day-one state for every existing user: months of startup records, zero
  // interaction records. A single readiness flag across both series turns that
  // into "no slowdowns" for a comparison that never ran.
  it('tracks readiness per series, not across them', async () => {
    await pastSession()
    const thin = await runPerfAnalysis(repo, WS, 1000)
    expect(thin.ready.interaction).toBe(false)
    expect(thin.ready.startup).toBe(false)

    await seedFiringHistory()
    const filled = await runPerfAnalysis(repo, WS, 2000)
    expect(filled.ready.interaction).toBe(true)
    // Startup records are written by a different recorder that never ran here,
    // so that series stays unready — which is exactly the asymmetry under test.
    expect(filled.ready.startup).toBe(false)
  })

  it('reports a fan-out regression on an attributable session', async () => {
    await seedFiringHistory()
    resetMetricsSession(repo)
    await writeInteractionSample(repo, WS)
    const analysis = await runPerfAnalysis(repo, WS, 1000)
    expect(analysis.interactionComparable).toBe(true)
    expect(analysis.regressions.map((r) => r.metric)).toContain('fanout:invalidationsPerWrite')
  })

  it('does not compare interaction counters once the session is unattributable', async () => {
    await seedFiringHistory()
    resetMetricsSession(repo)
    await writeInteractionSample(repo, WS)
    await writeInteractionSample(repo, OTHER_WS) // blends the counters

    const analysis = await runPerfAnalysis(repo, WS, 1000)
    expect(analysis.interactionComparable).toBe(false)
    expect(analysis.regressions.filter((r) => r.metric.startsWith('query:'))).toEqual([])
    expect(analysis.regressions.filter((r) => r.metric.startsWith('fanout:'))).toEqual([])
  })

  // Excluding by POSITION would drop a genuine past session in exactly the case
  // where this session has not written a record of its own.
  it('excludes this session\'s own record without discarding a past one', async () => {
    await seedFiringHistory()
    // A session that HAS written its record: it is history for nothing.
    resetMetricsSession(repo)
    await stamp((await writeInteractionSample(repo, WS))!, { recordedAt: 5e12, ...USABLE })
    const owned = await runPerfAnalysis(repo, WS, 1000)

    // A fresh session that has not written one: its predecessor is history now.
    resetMetricsSession(repo)
    const unowned = await runPerfAnalysis(repo, WS, 1000)

    expect(owned.baseline.interaction).toBeGreaterThan(0)
    expect(unowned.baseline.interaction).toBe(owned.baseline.interaction + 1)
  })

  // Reported, not corrected for: filtering the baseline to comparable graph
  // sizes would quietly disable the monitor on a steadily growing graph, which
  // is the normal case.
  it('reports how much the graph grew rather than suppressing the comparison', async () => {
    const addBlocks = async (tag: string, n: number): Promise<void> => {
      await repo.tx(async (tx) => {
        for (let i = 0; i < n; i++) {
          await tx.create({ id: `${tag}-${i}`, workspaceId: WS, parentId: null, orderKey: `b${i}`,
            content: 'x', properties: {} }, { systemMint: true })
        }
      }, { scope: ChangeScope.Automation })
    }
    // The baseline needs a graph to have measured; a session recorded against an
    // empty workspace contributes no size.
    await addBlocks('seed', 10)
    // Enough history that comparisons actually RUN — otherwise the assertion
    // below that a bigger graph does not silence them proves nothing.
    await seedFiringHistory()
    const before = (await runPerfAnalysis(repo, WS, 1000)).graphGrowth
    expect(before).not.toBeNull()

    await addBlocks('grew', 40)
    const after = await runPerfAnalysis(repo, WS, 2000)
    expect(after.graphGrowth!).toBeGreaterThan(before!)
    // Still compares — a bigger graph is context, not a reason to go quiet.
    expect(after.ready.interaction).toBe(true)
    expect(after.ready.startup || after.ready.interaction).toBe(true)
  })
})
