// @vitest-environment node
/**
 * Where property machinery rows are minted: at ids derived from what they are,
 * under a namespace a sealed workspace keys with `K_id`.
 *
 * Node, with a stubbed localStorage, because an `e2ee` mode pin is only
 * writable against a durable store. The sealed namespace is cached per (user,
 * workspace) for the life of the module, so every test takes a FRESH
 * workspace id.
 *
 * Expected ids are recomputed from LITERAL namespaces and key shapes, never
 * asked of the code under test — see `derivedIds.test.ts`.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { v5 as uuidv5 } from 'uuid'
import { ChangeScope, codecs, defineProperty, type AnyPropertySchema } from '@/data/api'
import type { Repo } from '@/data/repo'
import { projectedPropertyDefinitionsFacet } from '@/data/facets'
import { createTestDb, resetTestDb, type TestDb } from '@/data/test/createTestDb'
import { createTestRepo } from '@/data/test/createTestRepo'
import { storeWorkspaceKey, stubLocalStorage } from '@/data/test/e2eeFixtures'
import { getWorkspaceKeyStore } from '@/sync/keys/keyStore'
import { setModePin } from '@/sync/keys/modePin'
import { WorkspaceKeyUnavailableError } from '@/sync/keys/openWorkspaceKeys'
import { resolvePropertyChildNamespace } from './propertyChildMint'

const USER = 'user-prop-child-ids'
/** Spelled out: the plaintext namespace, and HMAC(K_id, 'km/property-child-ns/v1')
 *  for the key `storeWorkspaceKey(…, 7)` stores. */
const PLAINTEXT_NS = '4ddc11ad-ce83-4be7-813e-660f882e676d'
const SEALED_NS_FILL_7 = '096acf4c-89fd-4e56-8595-c23d6801e6da'

const STATUS_FIELD = '7e1f3a52-8c4d-4b69-a0e2-3f5a7c9e1d24'
const TAGS_FIELD = '8f2a4b63-9d5e-4c7a-b1f3-4a6c8e0f2b46'
const OWNER = '0b9d2c41-6a3e-4f58-9c71-2d4e6f8a0b13'

const statusSchema = defineProperty('status', {
  codec: codecs.string, defaultValue: '', changeScope: ChangeScope.BlockDefault,
})
const tagsSchema = defineProperty('tags', {
  codec: codecs.list(codecs.string), defaultValue: [] as string[], changeScope: ChangeScope.BlockDefault,
})

const fieldKey = (ws: string, owner: string, field: string) => `field|${ws}|${owner}|${field}`
const scalarKey = (ws: string, fieldRow: string) => `value|${ws}|${fieldRow}`
const memberKey = (ws: string, fieldRow: string, occurrence: number, value: string) =>
  `member|${ws}|${fieldRow}|${occurrence}|v["${value}"]`

let sharedDb: TestDb
let repo: Repo
let counter = 0
let WS = ''

const seedWorkspace = async (encryptionMode: 'none' | 'e2ee'): Promise<void> => {
  await sharedDb.db.execute(
    `INSERT OR REPLACE INTO workspaces
       (id, name, owner_user_id, create_time, update_time, encryption_mode, wk_canary, properties_migration)
     VALUES (?, 'ws', ?, 1, 1, ?, NULL, 'children')`,
    [WS, USER, encryptionMode])
}

const registerDefinition = (fieldId: string, schema: AnyPropertySchema): void => {
  repo.setRuntimeContributions(projectedPropertyDefinitionsFacet, `def-${fieldId}`, [{
    metadata: {
      fieldId, workspaceId: WS, createdAt: 1, name: schema.name,
      changeScope: schema.changeScope, hidden: false, origin: 'user' as const,
    },
    schema,
  }], {workspaceId: WS})
}

const write = (fn: Parameters<Repo['tx']>[0]) =>
  repo.tx(fn, {scope: ChangeScope.BlockDefault})

interface Row { id: string; content: string; deleted: number; parent_id: string | null }

const childrenOf = (parentId: string): Promise<Row[]> => sharedDb.db.getAll<Row>(
  'SELECT id, content, deleted, parent_id FROM blocks WHERE parent_id = ? ORDER BY order_key, id',
  [parentId])
const liveChildrenOf = async (parentId: string) =>
  (await childrenOf(parentId)).filter(row => row.deleted === 0)

beforeAll(async () => { sharedDb = await createTestDb() })
afterAll(async () => { await sharedDb.cleanup() })
afterEach(async () => {
  await getWorkspaceKeyStore().delete(USER, WS)
  vi.unstubAllGlobals()
})
beforeEach(async () => {
  await resetTestDb(sharedDb.db)
  stubLocalStorage()
  WS = `3f2b7c10-9d4e-4a61-8c2f-${String(++counter).padStart(12, '0')}`
  repo = createTestRepo({db: sharedDb.db, user: {id: USER}}).repo
  repo.setActiveWorkspaceId(WS)
  registerDefinition(STATUS_FIELD, statusSchema)
  registerDefinition(TAGS_FIELD, tagsSchema)
})

/** Create OWNER — with `properties`, in the same tx, when given. */
const createOwner = (properties?: Record<string, unknown>) => write(tx => tx.create({
  id: OWNER, workspaceId: WS, parentId: null, orderKey: 'k-owner', content: 'owner', properties,
}).then(() => undefined))

const derivedFieldRow = (ns: string, field = STATUS_FIELD) => uuidv5(fieldKey(WS, OWNER, field), ns)

describe('a plaintext workspace', () => {
  beforeEach(async () => {
    await seedWorkspace('none')
    setModePin(USER, WS, 'plaintext')
  })

  it('derives a scalar\'s field row and value child under a block created with it', async () => {
    await createOwner({status: 'done'})

    const fieldRowId = derivedFieldRow(PLAINTEXT_NS)
    expect((await liveChildrenOf(OWNER)).map(row => row.id)).toEqual([fieldRowId])
    expect(await liveChildrenOf(fieldRowId)).toEqual([expect.objectContaining({
      id: uuidv5(scalarKey(WS, fieldRowId), PLAINTEXT_NS), content: 'done',
    })])
  })

  it('derives them for a property set later in the transaction that created the block', async () => {
    await write(async tx => {
      await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'k-owner', content: 'owner'})
      await tx.setProperty(OWNER, statusSchema, 'done')
    })

    expect((await liveChildrenOf(OWNER)).map(row => row.id)).toEqual([derivedFieldRow(PLAINTEXT_NS)])
  })

  it('keys each list member by its value and its occurrence among equal members', async () => {
    await createOwner({tags: ['blue', 'red', 'blue']})

    const fieldRowId = derivedFieldRow(PLAINTEXT_NS, TAGS_FIELD)
    expect((await liveChildrenOf(fieldRowId)).map(({id, content}) => ({id, content}))).toEqual([
      {id: uuidv5(memberKey(WS, fieldRowId, 0, 'blue'), PLAINTEXT_NS), content: 'blue'},
      {id: uuidv5(memberKey(WS, fieldRowId, 0, 'red'), PLAINTEXT_NS), content: 'red'},
      {id: uuidv5(memberKey(WS, fieldRowId, 1, 'blue'), PLAINTEXT_NS), content: 'blue'},
    ])
  })

  it('takes random ids on a block that existed before the transaction', async () => {
    // A derived id there could meet a tombstone a peer left that this device
    // has not seen, and the server would keep the tombstone over this write.
    await createOwner()

    await write(tx => tx.setProperty(OWNER, statusSchema, 'done'))

    // Its value child still derives — from this random field row's id, which no
    // other device can compute, so nothing elsewhere can sit at it.
    const [field] = await liveChildrenOf(OWNER)
    expect(field!.id).not.toBe(derivedFieldRow(PLAINTEXT_NS))
    expect((await liveChildrenOf(field!.id)).map(row => row.id))
      .toEqual([uuidv5(scalarKey(WS, field!.id), PLAINTEXT_NS)])
  })

  it('takes a random id for a member added later under an existing field row', async () => {
    await createOwner({tags: ['blue']})
    const fieldRowId = derivedFieldRow(PLAINTEXT_NS, TAGS_FIELD)

    await write(tx => tx.setProperty(OWNER, tagsSchema, ['blue', 'red']))

    const red = (await liveChildrenOf(fieldRowId)).find(row => row.content === 'red')
    expect(red!.id).not.toBe(uuidv5(memberKey(WS, fieldRowId, 0, 'red'), PLAINTEXT_NS))
  })

  it('takes a random id when the transaction already used the slot', async () => {
    await write(async tx => {
      await tx.create({id: OWNER, workspaceId: WS, parentId: null, orderKey: 'k-owner', content: 'owner'})
      await tx.setProperty(OWNER, statusSchema, 'done')
      await tx.unsetProperty(OWNER, statusSchema)
      await tx.setProperty(OWNER, statusSchema, 'again')
    })

    const fields = await liveChildrenOf(OWNER)
    expect(fields).toHaveLength(1)
    expect(fields[0]!.id).not.toBe(derivedFieldRow(PLAINTEXT_NS))
    expect((await liveChildrenOf(fields[0]!.id)).map(row => row.content)).toEqual(['again'])
  })
})

describe('a sealed workspace', () => {
  beforeEach(async () => {
    await seedWorkspace('e2ee')
    setModePin(USER, WS, 'e2ee')
  })

  it('derives under HMAC(K_id, the versioned label), never the public namespace', async () => {
    await storeWorkspaceKey(USER, WS, 7)
    expect(await resolvePropertyChildNamespace(repo, WS)).toBe(SEALED_NS_FILL_7)

    await createOwner({status: 'done'})

    expect((await liveChildrenOf(OWNER)).map(row => row.id)).toEqual([derivedFieldRow(SEALED_NS_FILL_7)])
  })

  it('refuses to resolve without K_id, and the write mints a random id instead', async () => {
    await expect(resolvePropertyChildNamespace(repo, WS))
      .rejects.toBeInstanceOf(WorkspaceKeyUnavailableError)

    await createOwner({status: 'done'})

    const fields = await liveChildrenOf(OWNER)
    expect(fields).toHaveLength(1)
    expect(fields[0]!.id).not.toBe(derivedFieldRow(PLAINTEXT_NS))
    expect(fields[0]!.id).not.toBe(derivedFieldRow(SEALED_NS_FILL_7))
  })

  it('mints a random id when the key exists but nothing resolved it before the lock', async () => {
    await storeWorkspaceKey(USER, WS, 7)

    await createOwner({status: 'done'})

    const fields = await liveChildrenOf(OWNER)
    expect(fields).toHaveLength(1)
    expect(fields[0]!.id).not.toBe(derivedFieldRow(PLAINTEXT_NS))
    expect(fields[0]!.id).not.toBe(derivedFieldRow(SEALED_NS_FILL_7))
  })
})

describe('tx.createdInThisTx', () => {
  beforeEach(async () => {
    await seedWorkspace('none')
    setModePin(USER, WS, 'plaintext')
  })

  it('is true for a row this tx inserted, deleted or not, and false for one it only wrote', async () => {
    await createOwner()
    await write(async tx => {
      await tx.create({id: 'dead', workspaceId: WS, parentId: null, orderKey: 'k-dead'})
      await tx.delete('dead')
    })
    let seen: Record<string, boolean> = {}
    await write(async tx => {
      await tx.update(OWNER, {content: 'edited'})
      await tx.restore('dead')
      await tx.create({id: 'fresh', workspaceId: WS, parentId: null, orderKey: 'k-fresh'})
      await tx.create({id: 'gone', workspaceId: WS, parentId: null, orderKey: 'k-gone'})
      await tx.delete('gone')
      seen = {
        edited: tx.createdInThisTx(OWNER), fresh: tx.createdInThisTx('fresh'),
        gone: tx.createdInThisTx('gone'), restored: tx.createdInThisTx('dead'),
        untouched: tx.createdInThisTx('never-written'),
      }
    })
    expect(seen).toEqual({edited: false, fresh: true, gone: true, restored: false, untouched: false})
  })
})
