// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope } from '@/data/api'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { resolveFacetRuntimeSync } from '@/facets/facet.js'
import { typesProp } from '@/data/properties.js'
import {
  blockDateAdapterFacet,
  dailyNoteBlockId,
  dailyNotesDataExtension,
  getOrCreateDailyNote,
  pickBlockDateAdapter,
  referenceDateAdapter,
} from '@/plugins/daily-notes'
import {
  SRS_SM25_TYPE,
  srsBlockDateAdapter,
  srsNextReviewDateProp,
  srsReschedulingPlugin,
} from '../index.ts'

const WS = 'ws-1'

let sharedDb: TestDb
let h: TestDb
let repo: Repo

const extensions = [
  dailyNotesDataExtension,
  srsReschedulingPlugin,
  blockDateAdapterFacet.of(referenceDateAdapter, {source: 'test-ref'}),
]

const setupRuntime = () => {
  const runtime = resolveFacetRuntimeSync([kernelDataExtension, ...extensions])
  repo.setFacetRuntime(runtime)
  return runtime
}

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  h = sharedDb
  repo = createTestRepo({db: h.db, user: {id: 'user-1'}, extensions}).repo
})

describe('srsBlockDateAdapter', () => {
  it('canHandle requires SRS type AND a present next-review-date', async () => {
    const may1 = await getOrCreateDailyNote(repo, WS, '2026-05-01')

    await repo.tx(async tx => {
      await tx.create({id: 'srs-with-date', workspaceId: WS, parentId: null, orderKey: 'a',
        content: '',
        properties: {
          [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
          [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(may1.id),
        },
      })
      await tx.create({id: 'srs-without-date', workspaceId: WS, parentId: null, orderKey: 'b',
        content: '',
        properties: {
          [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        },
      })
      await tx.create({id: 'plain', workspaceId: WS, parentId: null, orderKey: 'c',
        content: 'no srs',
      })
    }, {scope: ChangeScope.BlockDefault})

    const withDate = repo.block('srs-with-date'); await withDate.load()
    const withoutDate = repo.block('srs-without-date'); await withoutDate.load()
    const plain = repo.block('plain'); await plain.load()

    expect(srsBlockDateAdapter.canHandle(withDate)).toBe(true)
    expect(srsBlockDateAdapter.canHandle(withoutDate)).toBe(false)
    expect(srsBlockDateAdapter.canHandle(plain)).toBe(false)
  })

  it('getCurrentIso resolves through the daily-note row', async () => {
    const target = await getOrCreateDailyNote(repo, WS, '2026-07-04')
    await repo.tx(tx => tx.create({id: 'srs', workspaceId: WS, parentId: null, orderKey: 'a',
      content: '',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(target.id),
      },
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('srs')
    await block.load()
    expect(await srsBlockDateAdapter.getCurrentIso(block)).toBe('2026-07-04')
  })

  it('setIso re-points srsNextReviewDateProp at the new daily note', async () => {
    const original = await getOrCreateDailyNote(repo, WS, '2026-05-01')
    await repo.tx(tx => tx.create({id: 'srs', workspaceId: WS, parentId: null, orderKey: 'a',
      content: '',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(original.id),
      },
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('srs')
    await block.load()

    expect(await srsBlockDateAdapter.setIso(block, '2026-06-15')).toBe(true)
    expect(block.get(srsNextReviewDateProp)).toBe(dailyNoteBlockId(WS, '2026-06-15'))
  })

  it('takes precedence over the reference adapter on SRS+inline-date blocks', async () => {
    // Both adapters CAN handle this block (SRS type + inline date in
    // content). Negative precedence on the SRS adapter should win, so
    // setting the date moves the next-review-date and leaves content
    // alone.
    const runtime = setupRuntime()

    const may1 = await getOrCreateDailyNote(repo, WS, '2026-05-01')
    await repo.tx(tx => tx.create({
      id: 'both', workspaceId: WS, parentId: null, orderKey: 'a',
      content: 'study [[2026-08-01]]',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(may1.id),
      },
    }), {scope: ChangeScope.BlockDefault})

    const block = repo.block('both')
    await block.load()

    const adapter = pickBlockDateAdapter(runtime, block)
    expect(adapter?.id).toBe(srsBlockDateAdapter.id)

    expect(await adapter?.setIso(block, '2026-06-15')).toBe(true)
    expect(block.peek()?.content).toBe('study [[2026-08-01]]')
    expect(block.get(srsNextReviewDateProp)).toBe(dailyNoteBlockId(WS, '2026-06-15'))
  })
})

describe('setIso undo grouping (issue #306)', () => {
  it('records ONE undo entry even when the target daily note must be created', async () => {
    repo.setActiveWorkspaceId(WS)
    const original = await getOrCreateDailyNote(repo, WS, '2026-05-01')
    await repo.tx(tx => tx.create({id: 'srs', workspaceId: WS, parentId: null, orderKey: 'a',
      content: '',
      properties: {
        [typesProp.name]: typesProp.codec.encode([SRS_SM25_TYPE]),
        [srsNextReviewDateProp.name]: srsNextReviewDateProp.codec.encode(original.id),
      },
    }), {scope: ChangeScope.BlockDefault})
    const block = repo.block('srs')
    await block.load()
    repo.undoManager.clear()

    // '2026-06-15' has no daily note yet — setIso creates it (its own
    // tx) then writes the property (another tx): merged into one entry.
    expect(await srsBlockDateAdapter.setIso(block, '2026-06-15')).toBe(true)
    expect(repo.undoManager.depths(ChangeScope.BlockDefault)).toEqual({undo: 1, redo: 0})

    expect(await repo.undo()).toBe(true)
    await block.load()
    expect(block.get(srsNextReviewDateProp)).toBe(original.id)
    const created = await repo.db.getOptional<{deleted: number}>(
      'SELECT deleted FROM blocks WHERE id = ?', [dailyNoteBlockId(WS, '2026-06-15')],
    )
    expect(created?.deleted).toBe(1)
  })
})
