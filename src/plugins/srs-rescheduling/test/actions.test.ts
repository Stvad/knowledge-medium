// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { dailyNoteBlockId } from '@/plugins/daily-notes'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/extensions/facet'
import { rescheduleBlock } from '../index.ts'
import { SrsSignal } from '../scheduler.ts'
import { srsReschedulingDataExtension } from '../dataExtension.ts'
import {
  SRS_SM25_TYPE,
  srsFactorProp,
  srsGradeProp,
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
  srsSnapshotHistoryProp,
} from '../schema.ts'

const WORKSPACE = 'ws-1'
const USER = 'user-1'

let h: TestDb
let repo: Repo

beforeEach(async () => {
  h = await createTestDb()
  let now = 1700_000_000_000
  let id = 0
  repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: USER},
    now: () => ++now,
    newId: () => `generated-${++id}`,
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    srsReschedulingDataExtension,
  ]))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await h.cleanup()
})

describe('rescheduleBlock', () => {
  it.each([
    [SrsSignal.AGAIN, 1, 2.3, 0, '2026-05-06'],
    [SrsSignal.HARD, 2.6, 2.35, 2, '2026-05-08'],
    [SrsSignal.GOOD, 5, 2.5, 4, '2026-05-10'],
    [SrsSignal.EASY, 5, 2.65, 5, '2026-05-10'],
    [SrsSignal.SOONER, 1.5, 2.5, 3, '2026-05-07'],
  ])(
    'adds SRS metadata from defaults for untyped blocks when signal %s is pressed',
    async (signal, expectedInterval, expectedFactor, expectedGrade, expectedIsoDate) => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date(2026, 4, 5))
      vi.spyOn(Math, 'random').mockReturnValue(0.5)

      await repo.tx(async tx => {
        await tx.create({
          id: 'plain-block',
          workspaceId: WORKSPACE,
          parentId: null,
          orderKey: 'a0',
          content: 'Start reviewing this',
        })
      }, {scope: ChangeScope.BlockDefault, description: 'seed plain block'})

      const block = repo.block('plain-block')
      await block.load()
      await rescheduleBlock(block, signal)

      const nextReviewId = dailyNoteBlockId(WORKSPACE, expectedIsoDate)
      const reviewedAtId = dailyNoteBlockId(WORKSPACE, '2026-05-05')
      expect(block.data.content).toBe('Start reviewing this')
      expect(block.types).toContain(SRS_SM25_TYPE)
      expect(block.get(srsIntervalProp)).toBeCloseTo(expectedInterval)
      expect(block.get(srsFactorProp)).toBeCloseTo(expectedFactor)
      expect(block.get(srsNextReviewDateProp)).toBe(nextReviewId)
      expect(block.get(srsReviewCountProp)).toBe(1)
      expect(block.get(srsGradeProp)).toBe(expectedGrade)
      expect(block.get(srsSnapshotHistoryProp)).toEqual([{
        reviewedAt: reviewedAtId,
        grade: expectedGrade,
        interval: expectedInterval,
        factor: expectedFactor,
        reviewCount: 1,
      }])
      expect(await repo.load(nextReviewId)).not.toBeNull()
      expect(await repo.load(reviewedAtId)).not.toBeNull()
    },
  )

  it('updates SRS typed properties without rewriting content', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 5))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await repo.tx(async tx => {
      await tx.create({
        id: 'srs-block',
        workspaceId: WORKSPACE,
        parentId: null,
        orderKey: 'a0',
        content: 'Review this card',
        properties: {
          [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
          [srsIntervalProp.name]: srsIntervalProp.codec.encode(10),
          [srsFactorProp.name]: srsFactorProp.codec.encode(2),
          [srsReviewCountProp.name]: srsReviewCountProp.codec.encode(3),
        },
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed srs block'})

    const block = repo.block('srs-block')
    await block.load()
    await rescheduleBlock(block, SrsSignal.GOOD)

    const nextReviewId = dailyNoteBlockId(WORKSPACE, '2026-05-25')
    const reviewedAtId = dailyNoteBlockId(WORKSPACE, '2026-05-05')
    expect(block.data.content).toBe('Review this card')
    expect(block.types).toContain(SRS_SM25_TYPE)
    expect(block.get(srsIntervalProp)).toBe(20)
    expect(block.get(srsFactorProp)).toBe(2)
    expect(block.get(srsNextReviewDateProp)).toBe(nextReviewId)
    expect(block.get(srsReviewCountProp)).toBe(4)
    expect(block.get(srsGradeProp)).toBe(4)
    expect(block.get(srsSnapshotHistoryProp)).toEqual([{
      reviewedAt: reviewedAtId,
      grade: 4,
      interval: 20,
      factor: 2,
      reviewCount: 4,
    }])
    expect(await repo.load(nextReviewId)).not.toBeNull()
    expect(await repo.load(reviewedAtId)).not.toBeNull()
  })
})
