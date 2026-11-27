// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import { kernelValuePresetsExtension } from '@/components/propertyEditors/kernelValuePresets'
import { ChangeScope } from '@/data/api'
import { propertyNameProp } from '@/data/properties'
import { propertyFieldContent } from '@/data/propertyChildren'
import { getOrCreatePropertiesPage } from '@/data/propertiesPage'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { createFakeSyncServer, type FakeSyncServer } from '@/data/test/fakeSyncServer'
import { __applyCompactedBlockOperationsForTest, __runUploadLoopForTest } from '@/services/powersync'
import { computePromotedFromChildren } from '../promotion'
import { ensurePromotedPropertySchemas, promotedValueAcceptorFor } from '../schemaReconciliation'

const WORKSPACE = uuidv5('promotion workspace', uuidv5.DNS)
const OWNER = uuidv5('imported message', WORKSPACE)
const NAME = 'test:status'
const ORIGINAL = 'waiting'
const EDITED = 'done'

let replicaDbs: [TestDb, TestDb]
beforeAll(async () => { replicaDbs = await Promise.all([createTestDb(), createTestDb()]) })
beforeEach(async () => { await Promise.all(replicaDbs.map(({db}) => resetTestDb(db))) })
afterAll(async () => { await Promise.all(replicaDbs.map(testDb => testDb.cleanup())) })

const createReplica = async ({db}: TestDb, label: string, clock: number) => {
  await db.writeTransaction(async tx => {
    await tx.execute(
      `INSERT INTO workspaces
         (id, name, owner_user_id, create_time, update_time, encryption_mode, properties_migration)
       VALUES (?, 'Workspace', 'user', 1, 1, 'none', 'children')`,
      [WORKSPACE],
    )
  })
  let id = 0
  const {repo} = createTestRepo({
    db,
    user: {id: 'user'},
    // Independent allocators must never make ordinary generated ids converge.
    newId: () => uuidv5(`${label}:${++id}`, WORKSPACE),
    now: () => ++clock,
    extensions: [kernelValuePresetsExtension],
    startSyncObserver: true,
  })
  repo.setActiveWorkspaceId(WORKSPACE)
  await repo.whenPropertyDefinitionsReady(WORKSPACE)
  return {db, repo, cursor: 0}
}

type Replica = Awaited<ReturnType<typeof createReplica>>

const upload = async ({db}: Replica, server: FakeSyncServer): Promise<void> => {
  const rejections: unknown[] = []
  await __runUploadLoopForTest(db, {
    applyOperations: (database, ops) => __applyCompactedBlockOperationsForTest(database, ops, server),
    recordRejection: async (_db, _tx, error) => { rejections.push(error) },
  }, new Map())
  expect(rejections).toEqual([])
}

const download = async (replica: Replica, server: FakeSyncServer): Promise<void> => {
  replica.cursor = await server.deliverTo(replica.db, replica.cursor)
  await replica.repo.flushSyncObserver()
}

const ingest = async ({repo}: Replica): Promise<string> => {
  expect(repo.userSchemas.getSchemaBlockId(NAME)).toBeUndefined()
  const {promoted, bubbled} = computePromotedFromChildren(
    [{uid: 'attribute', string: `status:: ${ORIGINAL}`}],
    new Set(),
    {namespacePrefix: 'test', acceptValue: promotedValueAcceptorFor(repo)},
  )
  expect([...bubbled]).toEqual(['attribute'])
  expect(promoted).toEqual({[NAME]: ORIGINAL})

  const row = {
    id: OWNER, workspaceId: WORKSPACE, parentId: null, orderKey: 'a0',
    content: 'Imported message', properties: promoted,
  }
  expect(await ensurePromotedPropertySchemas(repo, [row])).toEqual([])
  await repo.tx(async tx => { await tx.create(row) }, {scope: ChangeScope.BlockDefault})
  const fieldId = repo.userSchemas.getSchemaBlockId(NAME)
  expect(fieldId).toBeDefined()
  return fieldId!
}

const ownerStructure = async ({db}: Replica) => {
  const fields = await db.getAll<{id: string; content: string; is_field_form: number}>(
    'SELECT id, content, is_field_form FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY id',
    [OWNER],
  )
  return Promise.all(fields.map(async field => ({
    ...field,
    values: await db.getAll<{id: string; content: string}>(
      'SELECT id, content FROM blocks WHERE parent_id = ? AND deleted = 0 ORDER BY id',
      [field.id],
    ),
  })))
}

const liveDefinitions = ({db}: Replica, propertiesPageId: string) => db.getAll<{id: string}>(
  'SELECT id FROM blocks WHERE parent_id = ? AND deleted = 0 AND json_extract(properties_json, ?) = ? ORDER BY id',
  [propertiesPageId, '$.' + JSON.stringify(propertyNameProp.name), NAME],
)

it.each(['A', 'B'] as const)('converges when replica %s uploads the new attribute first', async firstWriter => {
  let serverClock = 1_800_000_000_000
  const server = createFakeSyncServer({now: () => ++serverClock})
  const a = await createReplica(replicaDbs[0], 'A', 1_700_000_000_000)
  const b = await createReplica(replicaDbs[1], 'B', 1_700_000_000_500)
  const [first, second] = firstWriter === 'A' ? [a, b] : [b, a]
  const propertiesPage = await getOrCreatePropertiesPage(a.repo, WORKSPACE)
  await upload(a, server)
  await download(a, server)
  await download(b, server)

  const definitionA = await ingest(a)
  const definitionB = await ingest(b)
  await upload(first, server)
  await upload(second, server)
  await download(a, server)
  await download(b, server)

  expect(await liveDefinitions(a, propertiesPage.id)).toEqual([{id: definitionA}])
  expect(await liveDefinitions(b, propertiesPage.id)).toEqual([{id: definitionA}])
  expect(definitionB).toBe(definitionA)
  const expectedFields = await ownerStructure(first)
  expect(expectedFields).toEqual([{
    id: expect.any(String), content: propertyFieldContent(definitionA), is_field_form: 1,
    values: [{id: expect.any(String), content: ORIGINAL}],
  }])
  expect(await ownerStructure(second)).toEqual(expectedFields)

  for (const {repo} of [a, b]) {
    await vi.waitFor(() => expect(repo.userSchemas.getSchemaBlockId(NAME)).toBe(definitionA))
    const schema = repo.userSchemas.getSchemaForBlockId(definitionA)!
    expect(schema.codec.type).toBe('string')
    const owner = repo.block(OWNER)
    await owner.load()
    expect(owner.get(schema)).toBe(ORIGINAL)
  }

  const schema = second.repo.userSchemas.getSchemaForBlockId(definitionA)!
  // The losing writer must edit the synced field and value in place.
  await second.repo.block(OWNER).set(schema, EDITED)
  await upload(second, server)
  await download(first, server)
  await download(second, server)

  for (const replica of [a, b]) {
    const owner = replica.repo.block(OWNER)
    expect(owner.get(replica.repo.userSchemas.getSchemaForBlockId(definitionA)!)).toBe(EDITED)
    expect(await ownerStructure(replica)).toEqual([{
      ...expectedFields[0]!,
      values: [{...expectedFields[0]!.values[0]!, content: EDITED}],
    }])
  }
}, 20_000)
