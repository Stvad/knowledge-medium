import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest'
import {ChangeScope} from '@/data/api'
import {EXTENSION_TYPE, HTML_DOCUMENT_TYPE} from '@/data/blockTypes'
import {createTestDb, resetTestDb, type TestDb} from '@/data/test/createTestDb'
import {createTestRepo} from '@/data/test/createTestRepo'
import type {Repo} from '@/data/repo'
import {findExtensionBlock} from './extensionLookup.ts'

const WS = 'ws-1'
const GENUINE = '11111111-1111-4111-8111-111111111111'
const CRAFTED = '22222222-2222-4222-8222-222222222222'

describe('extension lookups', () => {
  let db: TestDb
  let repo: Repo
  beforeAll(async () => {
    db = await createTestDb()
  })
  afterAll(() => db.cleanup())
  beforeEach(async () => {
    await resetTestDb(db.db)
    repo = createTestRepo({db: db.db, user: {id: 'user-1'}}).repo
    await repo.tx(async tx => {
      await tx.create({id: GENUINE, workspaceId: WS, parentId: null, orderKey: 'a0', content: 'genuine', properties: {types: [EXTENSION_TYPE]}})
      await tx.create({id: CRAFTED, workspaceId: WS, parentId: null, orderKey: 'a1', content: 'crafted', properties: {types: [EXTENSION_TYPE]}})
    }, {scope: ChangeScope.BlockDefault})
    // What a direct write could store. SQLite reads the first `types`, and
    // `JSON.parse` the last.
    await db.db.execute(
      `UPDATE blocks SET properties_json = ? WHERE id = ?`,
      [`{"types":["${EXTENSION_TYPE}"],"types":["${HTML_DOCUMENT_TYPE}"]}`, CRAFTED],
    )
  })

  it('has a row that really is listed as an extension in block_types', async () => {
    const rows = await db.db.getAll<{block_id: string}>(
      `SELECT block_id FROM block_types WHERE type = ? ORDER BY block_id`, [EXTENSION_TYPE],
    )
    expect(rows.map(row => row.block_id)).toEqual([GENUINE, CRAFTED])
  })

  it('does not list one whose own properties say otherwise', async () => {
    const blocks = await repo.query.findExtensionBlocks({workspaceId: WS}).load()
    expect(blocks.map(block => block.id)).toEqual([GENUINE])
  })

  it('does not find one whose own properties say otherwise', async () => {
    expect((await findExtensionBlock(repo, WS, {id: GENUINE}))?.block.id).toBe(GENUINE)
    expect(await findExtensionBlock(repo, WS, {id: CRAFTED})).toBeNull()
  })
})
