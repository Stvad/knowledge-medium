// @vitest-environment node
/**
 * The properties-as-blocks cell → children pass: what it migrates, what it
 * refuses to touch, and that a killed run picks up where it left off without
 * any progress state to go stale.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, seedProperty } from '@/data/api'
import { definitionSeedsFacet } from '@/data/facets'
import { kernelDataExtension } from '@/data/kernelDataExtension'
import { resolveFacetRuntimeSync } from '@/facets/facet'
import type { Repo } from '@/data/repo'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { PROPERTY_CELL_BACKFILL_ID } from './propertyCellBackfill'

const WS = 'ws-cell-backfill'

const noteProp = seedProperty({
  seedKey: 'test/property/note',
  revision: 1,
  name: 'demo:note',
  preset: 'optional-string',
  defaultValue: undefined,
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })

beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  repo = createTestRepo({db: sharedDb.db, user: {id: 'user-1'}}).repo
  repo.setActiveWorkspaceId(WS)
  repo.setFacetRuntime(resolveFacetRuntimeSync([
    kernelDataExtension,
    definitionSeedsFacet.of(noteProp, {source: 'test'}),
  ], {repo, workspaceId: WS, safeMode: false}))
})

const create = async (
  id: string, properties: Record<string, unknown>, opts: {content?: string} = {},
) => {
  await repo.tx(async tx => {
    await tx.create({
      id, workspaceId: WS, parentId: null, orderKey: `k-${id}`,
      content: opts.content ?? id, properties,
    })
  }, {scope: ChangeScope.BlockDefault, description: 'seed'})
}

const run = async () => repo.runWorkspaceBackfillNow(WS, PROPERTY_CELL_BACKFILL_ID)

/** Field rows under `parentId`, with the value rows beneath each. */
const fieldRowsOf = async (parentId: string) => {
  const fields = await repo.db.getAll<{id: string; content: string}>(
    `SELECT id, content FROM blocks
      WHERE parent_id = ? AND workspace_id = ? AND deleted = 0 AND is_field_form = 1
      ORDER BY order_key, id`,
    [parentId, WS],
  )
  return Promise.all(fields.map(async field => ({
    ...field,
    values: (await repo.db.getAll<{content: string}>(
      `SELECT content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY order_key, id`,
      [field.id],
    )).map(row => row.content),
  })))
}

/** Blocks the pass created, workspace-wide. */
const fieldRowCount = async (): Promise<number> => (await repo.db.get<{n: number}>(
  `SELECT COUNT(*) AS n FROM blocks
    WHERE workspace_id = ? AND deleted = 0 AND is_field_form = 1`, [WS],
))!.n

describe('property cell → children backfill', () => {
  it('gives a registered cell key its field row and value row', async () => {
    await create('b1', {'demo:note': 'hello'})

    expect((await run()).outcome).toBe('ran')

    const fields = await fieldRowsOf('b1')
    expect(fields).toHaveLength(1)
    expect(fields[0]!.values).toEqual(['hello'])
    // The cell is untouched — this pass ADDS the child representation, it does
    // not move the value. The workspace reads children only once it flips.
    expect((await repo.load('b1'))?.properties['demo:note']).toBe('hello')
  })

  it('leaves an unregistered key in the cell rather than inventing a definition', async () => {
    // Nothing declares this name, so no schema can back a field row. Deleting
    // or synthesizing here would be the pass making up data; the key stays
    // cell-only and `audit-properties` is what reports it.
    await create('b1', {'demo:nobody-declares-this': 'x'})

    expect((await run()).outcome).toBe('ran')

    expect(await fieldRowsOf('b1')).toEqual([])
    expect((await repo.load('b1'))?.properties['demo:nobody-declares-this']).toBe('x')
  })

  it('is a fixpoint — a second sweep of an already-migrated graph writes nothing', async () => {
    await create('b1', {'demo:note': 'hello'})
    await run()
    const after = await fieldRowCount()

    // The completion claim would normally stop a re-run; this asserts the pass
    // itself is idempotent, which is what makes a killed run safe to repeat.
    await repo.db.execute('DELETE FROM client_schema_state')
    expect((await run()).outcome).toBe('ran')

    expect(await fieldRowCount()).toBe(after)
    expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['hello'])
  })

  it('picks up where a killed run stopped, with no progress state to consult', async () => {
    // Resumability is derived from the data: the candidate query asks which
    // blocks still owe children. Simulated by migrating one block, then
    // dropping the claim as a crash would leave it.
    await create('b1', {'demo:note': 'one'})
    await create('b2', {'demo:note': 'two'})
    await run()
    await repo.db.execute('DELETE FROM client_schema_state')

    // A third block appears after the "crash" — the resumed run has to find it
    // without re-materializing the first two.
    await create('b3', {'demo:note': 'three'})
    expect((await run()).outcome).toBe('ran')

    expect((await fieldRowsOf('b1'))[0]!.values).toEqual(['one'])
    expect((await fieldRowsOf('b2'))[0]!.values).toEqual(['two'])
    expect((await fieldRowsOf('b3'))[0]!.values).toEqual(['three'])
    expect(await fieldRowCount()).toBe(3)
  })

  it('migrates past a batch boundary instead of stopping at the first page', async () => {
    // The cursor is `id > last`, so a batch that does not advance it, or one
    // that advances it past unvisited rows, silently leaves blocks cell-only —
    // and the claim would then record the migration as complete.
    const ids = Array.from({length: 250}, (_, i) => `b${String(i).padStart(4, '0')}`)
    for (const id of ids) await create(id, {'demo:note': id})

    expect((await run()).outcome).toBe('ran')

    expect(await fieldRowCount()).toBe(ids.length)
  })

  it('reports a block whose cell value cannot be decoded and migrates the rest', async () => {
    // A legacy raw `tx.update({properties})` can leave a value the schema's
    // codec rejects. The materializer REFUSES such a write — right for a live
    // edit, fatal for a sweep if it escaped, since one bad value would abort
    // the migration for the whole graph.
    await create('good', {'demo:note': 'fine'})
    await sharedDb.db.execute(
      `UPDATE blocks SET properties_json = ? WHERE id = ?`,
      [JSON.stringify({'demo:note': {not: 'a string'}}), 'good'],
    )
    await create('alsogood', {'demo:note': 'also fine'})

    expect((await run()).outcome).toBe('ran')

    expect((await fieldRowsOf('alsogood'))[0]!.values).toEqual(['also fine'])
    expect(await fieldRowsOf('good')).toEqual([])
  })

  it('clears the undo history it wrote past, and says so', async () => {
    await create('b1', {'demo:note': 'hello'})
    await repo.tx(async tx => {
      await tx.update('b1', {content: 'user edit'})
    }, {scope: ChangeScope.BlockDefault, description: 'user edit'})

    expect(await run()).toEqual({outcome: 'ran', undoHistoryCleared: true})

    await repo.undo(ChangeScope.BlockDefault)
    expect((await repo.load('b1'))?.content).toBe('user edit')
  })

  it('is never scheduled — only an operator can start it', async () => {
    await create('b1', {'demo:note': 'hello'})

    repo.scheduleWorkspaceBackfills(WS)
    await repo.awaitWorkspaceBackfills()

    expect(await fieldRowCount()).toBe(0)
  })
})
