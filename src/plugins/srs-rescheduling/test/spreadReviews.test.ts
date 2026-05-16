// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { BlockCache } from '@/data/blockCache'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, type TestDb } from '@/data/test/createTestDb'
import { typesProp } from '@/data/properties.ts'
import {
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
} from '@/plugins/daily-notes'
import { resolveFacetRuntimeSync } from '@/extensions/facet.ts'
import {
  SRS_SM25_TYPE,
  srsNextReviewDateProp,
  srsReschedulingDataExtension,
} from '../index.ts'
import {
  randomUpcomingDateOffset,
  spreadSrsReviewDates,
} from '../spreadReviews.ts'

const WS = 'ws-1'

let h: TestDb
let repo: Repo

beforeEach(async () => {
  h = await createTestDb()
  repo = new Repo({
    db: h.db,
    cache: new BlockCache(),
    user: {id: 'user-1'},
    registerKernelProcessors: false,
  })
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    dailyNotesDataExtension,
    srsReschedulingDataExtension,
  ]))
})

afterEach(async () => {
  await h.cleanup()
})

const seedSrsBlock = async (id: string) => {
  const original = await getOrCreateDailyNote(repo, WS, '2026-05-01')
  await repo.tx(tx => tx.create({
    id,
    workspaceId: WS,
    parentId: null,
    orderKey: `a-${id}`,
    content: id,
    properties: {
      [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
      [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(original.id),
    },
  }), {scope: ChangeScope.BlockDefault, description: `seed ${id}`})
}

describe('spreadSrsReviewDates', () => {
  it('maps random values to upcoming day offsets', () => {
    expect(randomUpcomingDateOffset(15, () => 0)).toBe(1)
    expect(randomUpcomingDateOffset(15, () => 0.999)).toBe(15)
    expect(randomUpcomingDateOffset(15, () => 1)).toBe(15)
  })

  it('randomly spreads eligible SRS blocks across upcoming daily notes', async () => {
    await seedSrsBlock('srs-a')
    await seedSrsBlock('srs-b')
    await repo.tx(tx => tx.create({
      id: 'plain',
      workspaceId: WS,
      parentId: null,
      orderKey: 'z-plain',
      content: 'plain',
    }), {scope: ChangeScope.BlockDefault, description: 'seed plain'})

    const blocks = [
      repo.block('srs-a'),
      repo.block('plain'),
      repo.block('srs-b'),
    ]
    let idx = 0
    const randomValues = [0, 0.99]

    const result = await spreadSrsReviewDates(blocks, {
      days: 10,
      now: new Date(2026, 4, 15),
      random: () => randomValues[idx++] ?? 0,
    })

    expect(result).toEqual({eligible: 2, updated: 2, skipped: 1})
    expect(repo.block('srs-a').get(srsNextReviewDateProp))
      .toBe(dailyNoteBlockId(WS, '2026-05-16'))
    expect(repo.block('srs-b').get(srsNextReviewDateProp))
      .toBe(dailyNoteBlockId(WS, '2026-05-25'))
    expect(await repo.load(dailyNoteBlockId(WS, '2026-05-16'))).not.toBeNull()
    expect(await repo.load(dailyNoteBlockId(WS, '2026-05-25'))).not.toBeNull()
  })
})
