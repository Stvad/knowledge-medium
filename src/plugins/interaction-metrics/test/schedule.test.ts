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
import { definitionSeedsFacet } from '@/data/facets'
import { interactionRecordProp, resetInteractionSessions } from '../record'
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
    extensions: [definitionSeedsFacet.of(interactionRecordProp, { source: 'test' })],
  }).repo
  repo.setActiveWorkspaceId(WS)
})
afterEach(() => { vi.restoreAllMocks() })

/** Let the scheduler's deferral macrotask fire, then await the job it queued. */
const settleSamples = async (): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  await drainInteractionSamples()
}

/** Count SAMPLES, not record blocks: a session updates one block in place, so
 *  the block count stays 1 however many times the effect re-samples — an
 *  assertion on it stays green with the cadence guard deleted. */
const countSampleWrites = (): (() => number) => {
  const spy = vi.spyOn(repo, 'tx')
  return () =>
    spy.mock.calls.filter(([, opts]) => opts?.description === 'interaction metrics record').length
}

describe('interactionMetricsEffect', () => {
  it('takes one sample and does not re-sample until the cadence elapses', async () => {
    const samples = countSampleWrites()
    const stop = interactionMetricsEffect.start({ repo, workspaceId: WS } as Parameters<
      typeof interactionMetricsEffect.start
    >[0])
    await settleSamples()
    // Opening the session writes the block, then the sample writes the property.
    const afterFirst = samples()
    expect(afterFirst).toBeGreaterThan(0)

    // Drive several more macrotasks. A re-arm routed through the idle scheduler
    // would have taken a fresh sample on each of them.
    for (let i = 0; i < 5; i++) await settleSamples()
    expect(samples()).toBe(afterFirst)
    stop?.()
  })

  it('stops sampling once the effect is torn down', async () => {
    vi.useFakeTimers()
    try {
      const samples = countSampleWrites()
      const stop = interactionMetricsEffect.start({ repo, workspaceId: WS } as Parameters<
        typeof interactionMetricsEffect.start
      >[0])
      await vi.advanceTimersByTimeAsync(1)
      await drainInteractionSamples()
      const afterFirst = samples()
      stop?.()
      // Past the resample cadence: a live effect would have queued another.
      await vi.advanceTimersByTimeAsync(10 * 60_000)
      await drainInteractionSamples()
      expect(samples()).toBe(afterFirst)
    } finally {
      vi.useRealTimers()
    }
  })
})
