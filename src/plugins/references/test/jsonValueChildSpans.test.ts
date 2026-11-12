// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { ChangeScope, codecs, defineProperty, type BlockData } from '@/data/api'
import { Repo } from '@/data/repo'
import { aliasesProp } from '@/data/properties'
import { projectedPropertyDefinitionsFacet } from '@/data/facets.js'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { computeAliasSeatId } from '@/data/targets'
import { PLAINTEXT_ALIAS_SEATS } from '@/data/test/plaintextAliasSeats'
import { aliasDataExtension } from '@/plugins/alias/dataExtension.js'
import { referencesDataExtension } from '../dataExtension.ts'

// A value child whose codec spells its content as JSON (the generic `list`
// preset's member, `json`, `raw-json`) must read as text to BOTH reference
// readers, as a string value child does: a span the inline reader finds in it
// makes the value a live reference that reference maintenance rewrites.

const WS = 'ws-1'
const FIELD_ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const INTO_ID = '11111111-1111-4111-8111-111111111111'
const FROM_ID = '22222222-2222-4222-8222-222222222222'

const genericList = defineProperty('generic-list', {
  codec: codecs.list(codecs.unsafeIdentity<unknown>()),
  defaultValue: [] as unknown[],
  changeScope: ChangeScope.BlockDefault,
})

let sharedDb: TestDb
let repo: Repo
let read: (id: string) => BlockData | undefined
beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  const created = createTestRepo({
    db: sharedDb.db,
    user: {id: 'user-1'},
    extensions: [referencesDataExtension, aliasDataExtension],
  })
  repo = created.repo
  read = id => created.cache.getSnapshot(id)
  repo.setActiveWorkspaceId(WS)
  await sharedDb.db.execute(
    `INSERT INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'ws', 'user-1', 1, 1, 'none', NULL, 'children')`,
    [WS],
  )
  repo.setRuntimeContributions(
    projectedPropertyDefinitionsFacet,
    'test-generic-list-definition',
    [{
      metadata: {
        fieldId: FIELD_ID,
        workspaceId: WS,
        createdAt: 1,
        name: genericList.name,
        changeScope: genericList.changeScope,
        hidden: false,
        origin: 'user' as const,
      },
      schema: genericList,
    }],
    {workspaceId: WS},
  )
})

const valueChildren = async (hostId: string) => sharedDb.db.getAll<{
  id: string
  content: string
  references_json: string
}>(
  `SELECT v.id, v.content, v.references_json FROM blocks f
     JOIN blocks v ON v.parent_id = f.id AND v.deleted = 0
    WHERE f.parent_id = ? AND f.reference_target_id = ? AND f.deleted = 0
    ORDER BY v.order_key`,
  [hostId, FIELD_ID],
)

const seed = async (value: unknown[]) => {
  await repo.tx(async tx => {
    await tx.create({id: 'p', workspaceId: WS, parentId: null, orderKey: 'a0'})
    for (const [id, name, orderKey] of [[INTO_ID, 'Target page', 'a1'], [FROM_ID, 'Source page', 'a2']]) {
      await tx.create({
        id, workspaceId: WS, parentId: 'p', orderKey, content: name,
        properties: {[aliasesProp.name]: aliasesProp.codec.encode([name])},
      })
    }
    await tx.create({id: 'host', workspaceId: WS, parentId: 'p', orderKey: 'a3', content: 'host'})
  }, {scope: ChangeScope.BlockDefault})
  await repo.tx(tx => tx.setProperty('host', genericList, value), {scope: ChangeScope.BlockDefault})
  await repo.awaitProcessors()
}

describe('a JSON-spelled value child is text to the reference readers (#1061)', () => {
  const value = [`see ((${FROM_ID}))`, '[[Fresh Name]]', [['nested']]]

  it('stores no reference and mints no alias seat for a span inside a JSON value', async () => {
    await seed(value)

    const children = await valueChildren('host')
    expect(children).toHaveLength(value.length) // precondition: the child-backed path ran
    for (const child of children) {
      expect(JSON.parse(child.references_json), child.content).toEqual([])
    }
    expect(read(computeAliasSeatId(PLAINTEXT_ALIAS_SEATS, 'Fresh Name', WS))).toBeUndefined()
    expect(read('host')!.properties[genericList.name]).toEqual(value)
  })

  it('keeps the value when a referenced block is merged away', async () => {
    await seed(value)

    await repo.mutate.merge({intoId: INTO_ID, fromId: FROM_ID, contentStrategy: 'keepTarget'})
    await repo.awaitProcessors()

    expect(read(FROM_ID)!.deleted).toBe(true) // precondition: the merge ran
    expect(read('host')!.properties[genericList.name]).toEqual(value)
  })
})
