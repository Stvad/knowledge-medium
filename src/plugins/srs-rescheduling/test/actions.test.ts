// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { dailyNoteBlockId } from '@/data/dailyNotes'
import { kernelDataExtension } from '@/data/kernelDataExtension'
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
  srsIntervalProp,
  srsNextReviewDateProp,
  srsReviewCountProp,
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
    srsReschedulingDataExtension,
  ]))
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await h.cleanup()
})

describe('rescheduleBlock', () => {
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
    expect(block.data.content).toBe('Review this card')
    expect(block.types).toContain(SRS_SM25_TYPE)
    expect(block.get(srsIntervalProp)).toBe(20)
    expect(block.get(srsFactorProp)).toBe(2)
    expect(block.get(srsNextReviewDateProp)).toBe(nextReviewId)
    expect(block.get(srsReviewCountProp)).toBe(4)
    expect(await repo.load(nextReviewId)).not.toBeNull()
  })
})
