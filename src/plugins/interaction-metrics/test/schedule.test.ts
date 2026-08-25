// @vitest-environment node
/**
 * The sampling effect's cadence. The property under test is that a session
 * takes ONE sample and then waits: the effect re-arms itself, and the idle
 * scheduler it runs through has no wall-clock floor outside the browser, so a
 * re-arm expressed in terms of that scheduler would sample once per macrotask.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import type { User } from '@/data/api'
import { definitionSeedsFacet, typeSeedsFacet } from '@/data/facets'
import { interactionRecordProp, interactionRecordType, resetInteractionSessions } from '../record'
import { drainInteractionSamples, interactionMetricsEffect } from '../schedule'

const WS = 'ws-1'
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
afterEach(() => { vi.restoreAllMocks() })

/** Advance past the sampler's wall-clock floor, then drain the idle job it
 *  queued. The floor is a real timer precisely so it holds outside the browser,
 *  which means a test has to move the clock rather than yield a macrotask. */
const settleSamples = async (ms = 61_000): Promise<void> => {
  await vi.advanceTimersByTimeAsync(ms)
  await drainInteractionSamples()
}

/** Count SAMPLES, not record blocks: a session updates one block in place, so
 *  the block count stays 1 however many times the effect re-samples -- an
 *  assertion on it stays green with the cadence guard deleted. */
const countSampleWrites = (): (() => number) => {
  const spy = vi.spyOn(repo, 'tx')
  return () =>
    spy.mock.calls.filter(([, opts]) => opts?.description === 'interaction metrics record').length
}

describe('interactionMetricsEffect', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  // The floor must hold in every environment, not just the browser: the idle
  // scheduler drops it outside one, and a sampler that fires immediately writes
  // metrics records in every test file that mounts the app.
  it('does not sample before the wall-clock floor', async () => {
    const samples = countSampleWrites()
    const stop = await interactionMetricsEffect.start({ repo, workspaceId: WS } as Parameters<
      typeof interactionMetricsEffect.start
    >[0])
    await settleSamples(30_000)
    expect(samples()).toBe(0)
    stop?.()
  })

  it('takes one sample and does not re-sample until the cadence elapses', async () => {
    const samples = countSampleWrites()
    const stop = await interactionMetricsEffect.start({ repo, workspaceId: WS } as Parameters<
      typeof interactionMetricsEffect.start
    >[0])
    await settleSamples()
    // Opening the session writes the block, then the sample writes the property.
    const afterFirst = samples()
    expect(afterFirst).toBeGreaterThan(0)

    // Well past the floor but short of the resample cadence.
    await settleSamples(60_000)
    expect(samples()).toBe(afterFirst)

    // And past the cadence it samples again.
    await settleSamples(5 * 60_000)
    expect(samples()).toBeGreaterThan(afterFirst)
    stop?.()
  })

  it('stops sampling once the effect is torn down', async () => {
    const samples = countSampleWrites()
    const stop = await interactionMetricsEffect.start({ repo, workspaceId: WS } as Parameters<
      typeof interactionMetricsEffect.start
    >[0])
    await settleSamples()
    const afterFirst = samples()
    stop?.()
    await settleSamples(10 * 60_000)
    expect(samples()).toBe(afterFirst)
  })
})
