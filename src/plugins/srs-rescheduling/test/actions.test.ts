// @vitest-environment node

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { dailyNoteBlockId } from '@/plugins/daily-notes'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { dailyNotesDataExtension } from '@/plugins/daily-notes'
import { typesProp } from '@/data/properties'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import {
  formatRescheduleToastMessage,
  rescheduleBlock,
} from '../index.ts'
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

let sharedDb: TestDb
let h: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  h = sharedDb
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
  repo.stopSyncObserver()
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

  it('returns reschedule metadata for toast feedback', async () => {
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
    const result = await rescheduleBlock(block, SrsSignal.GOOD)

    expect(result).not.toBeNull()
    expect(result!.signal).toBe(SrsSignal.GOOD)
    expect(result!.previousInterval).toBe(10)
    expect(result!.newInterval).toBe(20)
    expect(result!.previousReviewCount).toBe(3)
    expect(result!.nextReviewDate.getFullYear()).toBe(2026)
    expect(result!.nextReviewDate.getMonth()).toBe(4)
    expect(result!.nextReviewDate.getDate()).toBe(25)
  })

  it('returns null when the repo is read-only', async () => {
    await repo.tx(async tx => {
      await tx.create({
        id: 'srs-block',
        workspaceId: WORKSPACE,
        parentId: null,
        orderKey: 'a0',
        content: 'Review',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed'})

    const block = repo.block('srs-block')
    await block.load()
    vi.spyOn(block.repo, 'isReadOnly', 'get').mockReturnValue(true)

    expect(await rescheduleBlock(block, SrsSignal.GOOD)).toBeNull()
  })

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

describe('repo.undo after rescheduleBlock', () => {
  it('reverts SRS properties on a previously typed block', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 5))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await repo.tx(async tx => {
      await tx.create({
        id: 'srs-block',
        workspaceId: WORKSPACE,
        parentId: null,
        orderKey: 'a0',
        content: 'Card',
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
    expect(await rescheduleBlock(block, SrsSignal.GOOD)).not.toBeNull()
    expect(block.get(srsIntervalProp)).toBe(20)
    expect(block.get(srsReviewCountProp)).toBe(4)

    expect(await repo.undo()).toBe(true)
    await block.load()

    expect(block.types).toContain(SRS_SM25_TYPE)
    expect(block.get(srsIntervalProp)).toBe(10)
    expect(block.get(srsFactorProp)).toBe(2)
    expect(block.get(srsReviewCountProp)).toBe(3)
    expect(block.get(srsSnapshotHistoryProp)).toEqual([])
  })

  it('drops the SRS type when the block was untyped before reschedule', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 4, 5))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)

    await repo.tx(async tx => {
      await tx.create({
        id: 'plain-block',
        workspaceId: WORKSPACE,
        parentId: null,
        orderKey: 'a0',
        content: 'Plain',
      })
    }, {scope: ChangeScope.BlockDefault, description: 'seed plain block'})

    const block = repo.block('plain-block')
    await block.load()
    expect(await rescheduleBlock(block, SrsSignal.GOOD)).not.toBeNull()
    expect(block.types).toContain(SRS_SM25_TYPE)

    expect(await repo.undo()).toBe(true)
    await block.load()

    expect(block.types).not.toContain(SRS_SM25_TYPE)
    expect(block.data.content).toBe('Plain')
  })
})

describe('formatRescheduleToastMessage', () => {
  it('shows just the new interval and date for a first review', () => {
    const msg = formatRescheduleToastMessage({
      signal: SrsSignal.GOOD,
      previousInterval: 2,
      newInterval: 5,
      nextReviewDate: new Date(2026, 4, 10),
      previousReviewCount: 0,
    })
    expect(msg).toBe('GOOD · 5d (May 10)')
  })

  it('shows previous → new interval delta for subsequent reviews', () => {
    const msg = formatRescheduleToastMessage({
      signal: SrsSignal.GOOD,
      previousInterval: 3,
      newInterval: 7.4,
      nextReviewDate: new Date(2026, 4, 24),
      previousReviewCount: 4,
    })
    expect(msg).toBe('GOOD · 3d → 8d (May 24)')
  })

  it('renders long intervals in months', () => {
    const msg = formatRescheduleToastMessage({
      signal: SrsSignal.EASY,
      previousInterval: 30,
      newInterval: 90,
      nextReviewDate: new Date(2026, 7, 3),
      previousReviewCount: 6,
    })
    expect(msg).toBe('EASY · 1mo → 3mo (Aug 3)')
  })
})
