// @vitest-environment node
/**
 * The analysis pass, where the live snapshot meets the stored series. Both
 * things pinned here are silent when wrong: a comparison against blended
 * counters invents regressions, and identifying "this session's record" by
 * position discards a real one.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { ChangeScope, type User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import {
  interactionRecordProp,
  interactionRecordType,
  resetInteractionSessions,
  writeInteractionSample,
  type InteractionRecordData,
} from '@/plugins/interaction-metrics/record'
import { runPerfAnalysis } from '../analyze'

const WS = 'ws-1'
const OTHER_WS = 'ws-2'
const USER: User = { id: 'user-1', name: 'Alice' }

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  resetInteractionSessions()
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

/** Each call stands in for a separate past page session. */
const pastSession = async (over?: Partial<InteractionRecordData>): Promise<string> => {
  resetInteractionSessions()
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
  for (let i = 0; i < 8; i++) {
    await pastSession({ recordedAt: 1000 + i, writes: 100, fanout: { loaderInvalidations: 10 } })
  }
  for (let i = 0; i < 2; i++) {
    await pastSession({ recordedAt: 2000 + i, writes: 10, fanout: { loaderInvalidations: 100 } })
  }
}

describe('runPerfAnalysis', () => {
  // repo.metrics() is page-global. The recorder stops sampling once a session
  // has seen two workspaces; the reader holds the same blended snapshot and
  // does not inherit that rule by the recorder having one.
  // The positive control for the test below: with this history the fan-out
  // comparison DOES fire, so the suppression it asserts is a real difference.
  it('reports a fan-out regression on an attributable session', async () => {
    await seedFiringHistory()
    resetInteractionSessions()
    await writeInteractionSample(repo, WS)
    const analysis = await runPerfAnalysis(repo, WS, 1000)
    expect(analysis.interactionComparable).toBe(true)
    expect(analysis.regressions.map((r) => r.metric)).toContain('fanout:invalidationsPerWrite')
  })

  it('does not compare interaction counters once the session is unattributable', async () => {
    await seedFiringHistory()
    resetInteractionSessions()
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
    await pastSession()
    await pastSession()
    // A third session that HAS written its record: it is history for nothing.
    resetInteractionSessions()
    await writeInteractionSample(repo, WS)
    expect((await runPerfAnalysis(repo, WS, 1000)).baselineSessions).toBe(2)

    // A fresh session that has NOT yet written one: all three are history.
    resetInteractionSessions()
    expect((await runPerfAnalysis(repo, WS, 1000)).baselineSessions).toBe(3)
  })

  it('reports how much the graph grew rather than correcting for it', async () => {
    await pastSession()
    await pastSession()
    const analysis = await runPerfAnalysis(repo, WS, 1000)
    // Same graph across sessions here, so growth is flat rather than absent —
    // the field is populated whenever both sides are known.
    expect(analysis.graphGrowth).toBeCloseTo(1, 5)
  })
})
