// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync, type FacetRuntime } from '@/facets/facet.js'
import {
  SRS_SM25_TYPE,
  srsNextReviewDateProp,
  srsReschedulingDataExtension,
} from '@/plugins/srs-rescheduling'
import { srsBlockDateAdapter } from '@/plugins/srs-rescheduling/srsBlockDateAdapter.js'
import { typesProp } from '@/data/properties.js'
import {
  blockDateAdapterFacet,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  randomUpcomingDateOffset,
  referenceDateAdapter,
  spreadBlockDates,
} from '../index.ts'

const WS = 'ws-1'

let sharedDb: TestDb
let h: TestDb
let repo: Repo
let runtime: FacetRuntime

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  h = sharedDb
  const extensions = [
    dailyNotesDataExtension,
    srsReschedulingDataExtension,
    // Adapters are normally contributed by their plugins'
    // *Plugin extensions; we only pull in the dataExtensions for
    // this test, so register the two adapters explicitly. Negative
    // precedence on SRS matches the runtime wiring in
    // `srsReschedulingPlugin`.
    blockDateAdapterFacet.of(srsBlockDateAdapter, {
      source: 'srs-rescheduling',
      precedence: -1,
    }),
    blockDateAdapterFacet.of(referenceDateAdapter, {source: 'daily-notes'}),
  ]
  ;({repo} = createTestRepo({
    db: h.db,
    user: {id: 'user-1'},
    extensions,
  }))
  runtime = resolveFacetRuntimeSync([kernelDataExtension, ...extensions])
})

const seedSrsBlock = async (id: string): Promise<void> => {
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
  }), {scope: ChangeScope.BlockDefault, description: `seed srs ${id}`})
}

const seedReferenceBlock = async (id: string, iso: string): Promise<void> => {
  await getOrCreateDailyNote(repo, WS, iso)
  await repo.tx(tx => tx.create({
    id,
    workspaceId: WS,
    parentId: null,
    orderKey: `a-${id}`,
    content: `meeting [[${iso}]]`,
  }), {scope: ChangeScope.BlockDefault, description: `seed ref ${id}`})
}

const seedPlainBlock = async (id: string): Promise<void> => {
  await repo.tx(tx => tx.create({
    id,
    workspaceId: WS,
    parentId: null,
    orderKey: `z-${id}`,
    content: id,
  }), {scope: ChangeScope.BlockDefault, description: `seed plain ${id}`})
}

describe('spreadBlockDates', () => {
  it('maps random values to upcoming day offsets', () => {
    expect(randomUpcomingDateOffset(15, () => 0)).toBe(1)
    expect(randomUpcomingDateOffset(15, () => 0.999)).toBe(15)
    expect(randomUpcomingDateOffset(15, () => 1)).toBe(15)
  })

  it('dispatches through the right adapter for each block', async () => {
    await seedSrsBlock('srs-card')
    await seedReferenceBlock('inline-ref', '2026-04-01')
    await seedPlainBlock('plain')

    const blocks = [
      repo.block('srs-card'),
      repo.block('inline-ref'),
      repo.block('plain'),
    ]
    let idx = 0
    const randomValues = [0, 0.99]

    const result = await spreadBlockDates(runtime, blocks, {
      days: 10,
      now: new Date(2026, 4, 15),
      random: () => randomValues[idx++] ?? 0,
    })

    expect(result).toEqual({eligible: 2, updated: 2, skipped: 1})

    // SRS adapter rewrites srsNextReviewDateProp.
    const srsBlock = repo.block('srs-card')
    expect(srsBlock.get(srsNextReviewDateProp)).toBe(
      dailyNoteBlockId(WS, '2026-05-16'),
    )

    // Reference adapter rewrites the inline wikilink in content.
    const refData = await repo.load('inline-ref')
    expect(refData?.content).toBe('meeting [[2026-05-25]]')

    // SRS adapter materialises its target daily note as a side
    // effect; the reference adapter just rewrites content and
    // leaves materialisation to the references post-commit
    // processor (not registered in this test setup).
    expect(await repo.load(dailyNoteBlockId(WS, '2026-05-16'))).not.toBeNull()
  })

  it('honours the adapter precedence — SRS wins over reference for dual-shape blocks', async () => {
    // Block has BOTH the SRS type and an inline date reference. The
    // SRS adapter is registered with negative precedence so it
    // should reschedule the SRS row, leaving the inline reference
    // untouched.
    const originalDaily = await getOrCreateDailyNote(repo, WS, '2026-05-01')
    await repo.tx(tx => tx.create({
      id: 'dual',
      workspaceId: WS,
      parentId: null,
      orderKey: 'a-dual',
      content: 'review [[2026-05-01]]',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(
          originalDaily.id,
        ),
      },
    }), {scope: ChangeScope.BlockDefault, description: 'seed dual'})

    const result = await spreadBlockDates(runtime, [repo.block('dual')], {
      days: 5,
      now: new Date(2026, 4, 15),
      random: () => 0.5,
    })

    expect(result).toEqual({eligible: 1, updated: 1, skipped: 0})

    const dualBlock = repo.block('dual')
    expect(dualBlock.get(srsNextReviewDateProp)).not.toBe(originalDaily.id)
    const dualData = await repo.load('dual')
    // Inline reference still points at the original date.
    expect(dualData?.content).toBe('review [[2026-05-01]]')
  })
})
